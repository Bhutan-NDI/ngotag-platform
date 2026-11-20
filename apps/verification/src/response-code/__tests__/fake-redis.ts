class FakeTransaction {
  private readonly commands: (() => number | string | null)[] = [];

  constructor(private readonly redis: FakeRedis) {}

  set(key: string, value: string | number, _mode: 'EX', ttl: number, condition?: 'NX'): this {
    this.commands.push(() => {
      if ('NX' === condition && this.redis.store.has(key)) {
        return null;
      }
      this.redis.store.set(key, String(value));
      this.redis.ttls.set(key, ttl);
      return 'OK';
    });
    return this;
  }

  incr(key: string): this {
    this.commands.push(() => {
      const next = Number(this.redis.store.get(key) ?? 0) + 1;
      this.redis.store.set(key, String(next));
      return next;
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

  /** Outside a transaction, only the KEEPTTL XX and PX <ms> NX forms are used. */
  async set(key: string, value: string, ...options: ['KEEPTTL', 'XX'] | ['PX', number, 'NX']): Promise<'OK' | null> {
    this.assertConnected();
    if ('KEEPTTL' === options[0] && 'XX' === options[1]) {
      if (!this.store.has(key)) {
        return null;
      }
      this.store.set(key, value);
      return 'OK';
    }
    if ('PX' === options[0] && 'NX' === options[2]) {
      if (this.store.has(key)) {
        return null;
      }
      this.store.set(key, value);
      this.ttls.set(key, options[1] / 1000);
      return 'OK';
    }
    throw new Error(`FakeRedis.set does not support ${options.join(' ')}`);
  }

  /** -2 for a missing key and -1 for one without an expiry, as Redis does. */
  async pttl(key: string): Promise<number> {
    this.assertConnected();
    if (!this.store.has(key)) {
      return -2;
    }
    return this.ttls.has(key) ? this.ttls.get(key) * 1000 : -1;
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
