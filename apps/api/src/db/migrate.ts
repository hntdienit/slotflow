import { Client } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

/** Applies pending *.sql files in name order, each in its own transaction. Returns applied names. */
export async function migrate(adminUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727274)"); // serialise concurrent migrators
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    await client.end();
  }
  return applied;
}
