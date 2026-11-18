import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  readonly db: Database = drizzle(this.pool, { schema });

  /**
   * Runs `fn` in a transaction scoped to one tenant. `app.tenant_id` is set with set_config(..., true)
   * (transaction-local), which the RLS policies read. Without it, every query sees zero rows.
   * Drizzle rolls back and rethrows if `fn` throws.
   */
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
