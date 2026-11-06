import { CustomTransportStrategy, MsPattern, NatsContext, Server } from '@nestjs/microservices';
import { headers as natsHeaders } from 'nats';
import { isObservable, lastValueFrom } from 'rxjs';

// Registers a controller's handlers without a broker, so messages go through Nest's own
// RPC argument resolution instead of calling controller methods directly.
export class InMemoryTransport extends Server implements CustomTransportStrategy {
  listen(callback: () => void): void {
    callback();
  }

  close(): void {}

  on(): void {}

  unwrap<T>(): T {
    throw new Error('In-memory transport has no broker');
  }

  async dispatch(pattern: MsPattern, data: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const handler = this.getHandlerByPattern(this.normalizePattern(pattern));
    const msgHeaders = natsHeaders();
    Object.entries(headers).forEach(([name, value]) => msgHeaders.set(name, value));
    const result = await handler(data, new NatsContext(['issuance', msgHeaders]));
    return isObservable(result) ? lastValueFrom(result) : result;
  }
}
