# ADR-003: Data access — `pg` + hand-written SQL migrations (no heavy ORM)

Status: accepted · 2026-11-18

## Context

The core guarantees rely on PostgreSQL features: exclusion constraints on `tstzrange`, Row Level
Security, `btree_gist`, transactional outbox. Full ORMs model these poorly or hide them.

## Decision

Plain SQL migrations (versioned files, applied in order by a small runner) and the `pg` driver,
with thin typed repository functions. Kysely may be added later for typed query building without
changing the migrations. Tenant isolation: each request runs in a transaction that sets
`SET LOCAL app.tenant_id`, which the RLS policies read.

## Consequences

- The schema (constraints, RLS) is readable and reviewable as SQL — the strongest portfolio signal.
- More hand-written queries; mitigated by small repositories and integration tests.
