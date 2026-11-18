/**
 * Postgres SQLSTATE (e.g. 23505) behind any error: raw `pg`, or Prisma errors, which wrap the driver
 * error in `cause` / `meta.driverAdapterError`. Prisma's own codes (P2002 ...) are not SQLSTATEs.
 */
export function pgCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): string | undefined => {
    if (!v || typeof v !== "object" || depth > 5 || seen.has(v)) return undefined;
    seen.add(v);
    const o = v as Record<string, unknown>;
    for (const key of ["code", "originalCode", "sqlState"]) {
      const c = o[key];
      if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) && !/^P\d{4}$/.test(c)) return c;
    }
    for (const key of ["cause", "meta", "driverAdapterError", "error"]) {
      const found = walk(o[key], depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(err, 0);
}

export function prismaCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^P\d{4}$/.test(c) ? c : undefined;
}

export function pgMessage(err: unknown): string {
  const e = err as { message?: string };
  return (
    (e?.message ?? "database error").split("\n").filter(Boolean).slice(-1)[0] ?? "database error"
  );
}
