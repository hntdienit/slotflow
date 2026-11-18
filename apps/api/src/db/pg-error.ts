/** Postgres SQLSTATE of an error, whether raw from `pg` or wrapped by Drizzle (`cause`). */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}
export function pgMessage(err: unknown): string {
  const e = err as { cause?: { message?: string }; message?: string };
  return e?.cause?.message ?? e?.message ?? "database error";
}
