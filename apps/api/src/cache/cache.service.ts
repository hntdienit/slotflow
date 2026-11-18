import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

/**
 * Best-effort cache on Redis. Redis is never a source of truth (ADR-001/002): every operation swallows
 * connection errors and behaves as a cache miss, so losing Redis only costs speed, not correctness.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly log = new Logger(CacheService.name);
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 250,
    retryStrategy: (n) => Math.min(n * 200, 2000),
  });

  constructor() {
    this.redis.on("error", () => undefined); // reported per call below
  }

  private async safe<T>(op: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      if (this.redis.status === "wait") await this.redis.connect();
      return await fn();
    } catch (e) {
      this.log.debug(`cache ${op} failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    const raw = await this.safe("get", () => this.redis.get(key));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.safe("set", () => this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds));
  }

  /**
   * Version counters make invalidation O(1): cache keys embed the versions, so bumping a counter
   * orphans every entry that depends on it (they expire by TTL). Unknown/unreachable => "0".
   */
  async versions(keys: string[]): Promise<string[]> {
    const vals = await this.safe("mget", () => this.redis.mget(keys));
    return keys.map((_, i) => vals?.[i] ?? "0");
  }

  async bump(key: string): Promise<void> {
    await this.safe("incr", () => this.redis.incr(key));
  }

  /** Working hours, time off, staff, services, resources or branch settings changed. */
  bumpCatalog(tenantId: string) {
    return this.bump(`ver:cat:${tenantId}`);
  }
  /** A booking on this branch was created, changed or released (called from M3). */
  bumpBranch(tenantId: string, branchId: string) {
    return this.bump(`ver:br:${tenantId}:${branchId}`);
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }
}
