# ADR-003: Data access — Prisma ORM + hand-written SQL migrations

Status: accepted · 2026-11-18 (revised twice at the author's request: plain `pg` → Drizzle → Prisma)

## Context

The core guarantees rely on PostgreSQL features: exclusion constraints on `tstzrange`, Row Level
Security, `btree_gist`, generated columns, partial and composite constraints. No ORM expresses all
of these in its schema language.

## Decision

- **Prisma 7** (`@prisma/client` with the `@prisma/adapter-pg` driver adapter) for all queries:
  typed models in `apps/api/prisma/schema.prisma`, typed create/update/find, interactive transactions.
  The client is generated into `src/generated/prisma` (git-ignored) by `prisma generate`, run from the
  `postinstall` script.
- **DDL lives in versioned SQL migrations** (`apps/api/migrations`, applied by a small runner),
  because RLS policies, `EXCLUDE USING gist`, partial unique indexes and composite tenant FKs are
  not expressible in `schema.prisma`. Prisma Migrate would generate DDL from the models and drop them.
  The Prisma models therefore declare scalar columns only (no relations); integrity is enforced by the DB.
- `schema-drift.int.test.ts` compares the tables/columns declared in `schema.prisma` with the migrated
  database in both directions and fails on any difference.
- **Tenant isolation:** `DbService.withTenant(tenantId, fn)` opens an interactive transaction and runs
  `set_config('app.tenant_id', $1, true)` before `fn`; RLS policies read it and fail closed.
- **Known limits, handled deliberately:**
  - `tstzrange` is `Unsupported` in Prisma, so `booking_resources` (the exclusion-constraint table) is
    written with `$executeRaw` in the booking service (M3). That is where the concurrency logic lives
    anyway, and the SQL stays visible.
  - Postgres `time` columns surface as `Date` (1970-01-01 UTC); the API converts to/from `"HH:MM"`.
  - Prisma wraps driver errors; SQLSTATE is read through `pgCode()` (walks `cause`/`meta`).

## Consequences

- Type-safe queries and refactors for the catalog; concurrency-critical SQL remains explicit.
- Two artefacts per schema change (migration + `schema.prisma`), guarded by the drift test.
