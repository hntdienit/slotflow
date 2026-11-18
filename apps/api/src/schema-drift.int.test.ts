import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { admin } from "../test/helpers";

// DB columns intentionally not mapped in Prisma (documented in schema.prisma).
const UNMAPPED = new Set(["time_off.range"]);

/** table.column pairs declared by prisma/schema.prisma (scalar fields only; there are no relations). */
function prismaColumns(): Set<string> {
  const src = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)) {
    const body = m[1] ?? "";
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1];
    if (!table) throw new Error("model without @@map");
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("//") || t.startsWith("@@")) continue;
      const name = /^(\w+)\s/.exec(t)?.[1];
      if (!name) continue;
      out.add(`${table}.${/@map\("([^"]+)"\)/.exec(t)?.[1] ?? name}`);
    }
  }
  return out;
}

describe("prisma schema matches the migrated database", () => {
  it("has identical tables and columns (both directions)", async () => {
    const inCode = prismaColumns();
    expect(inCode.size).toBeGreaterThan(100);
    const dbCols = await admin(
      async (c) =>
        (
          await c.query(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name <> 'schema_migrations'",
          )
        ).rows as { table_name: string; column_name: string }[],
    );
    const inDb = new Set(dbCols.map((r) => `${r.table_name}.${r.column_name}`));
    const missingInDb = [...inCode].filter((x) => !inDb.has(x));
    const missingInCode = [...inDb].filter((x) => !inCode.has(x) && !UNMAPPED.has(x));
    expect({ missingInDb, missingInCode }).toEqual({ missingInDb: [], missingInCode: [] });
  });
});
