import { ServiceUnavailableException } from '@nestjs/common';
import { performance } from 'perf_hooks';

type Waiter = { resolve: () => void; reject: (error: Error) => void; deadline: number; timer?: NodeJS.Timeout };

export class IssuanceAdmissionQueue {
  private active = 0;
  private readonly pending = new Set<Waiter>();

  constructor(
    private readonly capacity: number,
    private readonly maxPending: number
  ) {}

  async run<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    await this.acquire(deadline);
    try {
      if (performance.now() >= deadline) {
        throw this.timeoutError();
      }
      return await operation();
    } finally {
      this.release();
    }
  }

  private timeoutError(): ServiceUnavailableException {
    return new ServiceUnavailableException('Issuance capacity wait exceeded; no offer was dispatched');
  }

  private async acquire(deadline: number): Promise<void> {
    if (performance.now() >= deadline) {
      throw this.timeoutError();
    }
    if (this.active < this.capacity) {
      this.active++;
      return;
    }
    if (this.pending.size >= this.maxPending) {
      throw new ServiceUnavailableException('Issuance admission queue is full; no offer was dispatched');
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, deadline };
      this.pending.add(waiter);
      waiter.timer = setTimeout(
        () => {
          if (this.pending.delete(waiter)) {
            reject(this.timeoutError());
          }
        },
        Math.max(0, deadline - performance.now())
      );
    });
  }

  private release(): void {
    for (const waiter of this.pending) {
      this.pending.delete(waiter);
      clearTimeout(waiter.timer);
      if (performance.now() >= waiter.deadline) {
        waiter.reject(this.timeoutError());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.active--;
  }
}
