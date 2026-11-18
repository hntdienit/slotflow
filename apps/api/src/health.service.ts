import { Injectable } from "@nestjs/common";
import { Pool } from "pg";
import Redis from "ioredis";

export interface HealthReport {
  status: "ok" | "degraded";
  postgres: boolean;
  redis: boolean;
}

@Injectable()
export class HealthService {
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([this.pingPostgres(), this.pingRedis()]);
    // Postgres is the source of truth; losing Redis only degrades (cache + queue), never corrupts.
    const status = postgres && redis ? "ok" : "degraded";
    return { status, postgres, redis };
  }

  private async pingPostgres(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      if (this.redis.status === "wait") await this.redis.connect();
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}
