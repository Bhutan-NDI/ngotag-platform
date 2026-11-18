class FakeTransaction {
  private readonly commands: (() => number | string)[] = [];

  constructor(private readonly redis: FakeRedis) {}

  set(key: string, value: string, _mode: 'EX', ttl: number): this {
    this.commands.push(() => {
      this.redis.store.set(key, value);
      this.redis.ttls.set(key, ttl);
      return 'OK';
    });
    return this;
  }

  del(key: string): this {
    this.commands.push(() => {
      this.redis.ttls.delete(key);
      return this.redis.store.delete(key) ? 1 : 0;
    });
    return this;
  }

  async exec(): Promise<[Error | null, unknown][] | null> {
    this.redis.assertConnected();
    if (this.redis.failNextExec) {
      this.redis.failNextExec = false;
      return null;
    }
    return this.commands.map((command) => [null, command()]);
  }
}

/** Minimal in-process stand-in for the ioredis commands ProofResponseCodeService uses. */
export class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  connected = true;
  failNextExec = false;

  async get(key: string): Promise<string | null> {
    this.assertConnected();
    return this.store.get(key) ?? null;
  }

  /** Only the KEEPTTL form is used outside a transaction. */
  async set(key: string, value: string, mode: 'KEEPTTL'): Promise<'OK'> {
    this.assertConnected();
    if ('KEEPTTL' !== mode) {
      throw new Error(`FakeRedis.set supports only KEEPTTL, got ${mode}`);
    }
    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    this.assertConnected();
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.assertConnected();
    this.ttls.set(key, ttl);
    return this.store.has(key) ? 1 : 0;
  }

  async eval(_script: string, _numKeys: number, ...args: (string | number)[]): Promise<number> {
    this.assertConnected();
    const [tokenKey, indexKey, expected, updated, ttl] = args as [string, string, string, string, number];
    if (this.store.get(tokenKey) !== expected) {
      return 0;
    }
    this.store.set(tokenKey, updated);
    this.ttls.set(tokenKey, Number(ttl));
    this.ttls.set(indexKey, Number(ttl));
    return 1;
  }

  multi(): FakeTransaction {
    return new FakeTransaction(this);
  }

  assertConnected(): void {
    if (!this.connected) {
      throw new Error('Redis connection is not writeable');
    }
  }
}
