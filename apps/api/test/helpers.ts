import { randomUUID } from "node:crypto";
import { Client } from "pg";

export async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Creates a tenant (id generated client-side so RLS context can be set before the insert). */
export async function createTenant(name: string): Promise<string> {
  const id = randomUUID();
  await admin(async (c) => {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    await c.query("INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)", [
      id,
      name,
      `${name}-${id.slice(0, 8)}`,
    ]);
    await c.query("COMMIT");
  });
  return id;
}

/** Runs as the non-superuser app role, so RLS applies exactly as it does in production. */
export async function asTenant<T>(tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } finally {
    await c.end();
  }
}
