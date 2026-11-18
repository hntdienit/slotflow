import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client";

export type Tx = Prisma.TransactionClient;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 10 }),
  });

  /**
   * Runs `fn` in an interactive transaction scoped to one tenant. `app.tenant_id` is set with
   * set_config(..., true) (transaction-local), which the RLS policies read. Without it, every query
   * sees zero rows. Prisma rolls back and rethrows if `fn` throws.
   */
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }
}
