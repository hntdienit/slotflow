import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./db/schema";
import { admin } from "../test/helpers";

// DB columns intentionally not mapped in Drizzle (documented in schema.ts).
const UNMAPPED = new Set(["time_off.range"]);

describe("drizzle schema matches the migrated database", () => {
  it("has identical tables and columns (both directions)", async () => {
    const tables = Object.values(schema).filter((v): v is PgTable => v instanceof PgTable);
    expect(tables.length).toBeGreaterThanOrEqual(19);
    const dbCols = await admin(
      async (c) =>
        (
          await c.query(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name <> 'schema_migrations'",
          )
        ).rows as { table_name: string; column_name: string }[],
    );
    const inDb = new Set(dbCols.map((r) => `${r.table_name}.${r.column_name}`));
    const inCode = new Set(
      tables.flatMap((t) => {
        const cfg = getTableConfig(t);
        return cfg.columns.map((col) => `${cfg.name}.${col.name}`);
      }),
    );
    const missingInDb = [...inCode].filter((x) => !inDb.has(x));
    const missingInCode = [...inDb].filter((x) => !inCode.has(x) && !UNMAPPED.has(x));
    expect({ missingInDb, missingInCode }).toEqual({ missingInDb: [], missingInCode: [] });
  });
});
