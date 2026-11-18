# ADR-003: Data access — Drizzle ORM + hand-written SQL migrations

Status: accepted · 2026-11-18 (revised: the author asked for an ORM; initially plain `pg`)

## Context

The core guarantees rely on PostgreSQL features: exclusion constraints on `tstzrange`, Row Level
Security, `btree_gist`, generated columns, partial and composite constraints. Full ORMs such as
Prisma/TypeORM either cannot express these or hide them.

## Decision

- **Drizzle ORM** (`drizzle-orm/node-postgres`) for all queries: typed tables in `src/db/schema.ts`,
  typed insert/update/select, transactions. It stays close to SQL, so the booking transaction is
  readable, and raw `sql` fragments remain available for range operators.
- **DDL lives in versioned SQL migrations** (`apps/api/migrations`, applied by a small runner),
  because RLS policies, `EXCLUDE USING gist`, partial unique indexes and composite tenant FKs are
  not expressible in Drizzle's schema DSL. Generating migrations from the TS schema would lose them.
- To remove the risk of two sources of truth, `schema-drift.int.test.ts` compares Drizzle's tables and
  columns with the migrated database in both directions and fails on any difference.
- Tenant isolation: `DbService.withTenant(tenantId, fn)` opens a transaction and runs
  `set_config('app.tenant_id', $1, true)` before `fn`; RLS policies read it and fail closed.
- Errors: Drizzle wraps driver errors, so SQLSTATE is read via `pgCode()` (checks `error.cause`).

## Consequences

- Type-safe queries and refactors; the schema (constraints, RLS) remains reviewable SQL.
- Two artefacts per schema change (migration + `schema.ts`), guarded by the drift test.
