# Security review (M8)

A self-review by the author and an AI assistant, not an external audit. It lists what was checked, how, and what is
still open. Everything here is fake data in a demo project.

## Checked and holding

| Area             | What was checked                                                                                                                                                                                                                | Evidence                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tenant isolation | Every table has RLS forced; the API connects as a role that is neither superuser nor `BYPASSRLS`; a request without tenant context sees zero rows                                                                               | `rls.int.test.ts`; `auth.int.test.ts` (token for tenant A cannot read tenant B even with B's `x-tenant-id`) |
| Authentication   | HS256 verified with a fixed algorithm, constant-time compare, mandatory `exp`; forged, expired, `alg: none` and garbage tokens rejected; uniform login errors and constant-time-ish unknown-user path; login throttle           | `auth/token.test.ts`, `auth.int.test.ts`                                                                    |
| Authorization    | Rule table denies unknown routes in `jwt` mode; customers limited to themselves and their own bookings/offers/entries; managers to assigned branches; branch creation owner-only; other people's objects answer 404             | `auth.int.test.ts` (9 tests)                                                                                |
| Double booking   | Exclusion constraint is the arbiter, not application locks; 100 racing requests give exactly one success; k6 run produced 0 overlapping rows                                                                                    | `booking.int.test.ts`, `docs/benchmarks.md`                                                                 |
| Idempotency      | A repeated `Idempotency-Key` returns the same booking; the same key with a different payload is rejected                                                                                                                        | `booking.int.test.ts`, `assistant.int.test.ts`                                                              |
| SQL injection    | Every raw query is a tagged template or `Prisma.sql`; no `*Unsafe` calls; filters on `/admin/:entity` are validated against a per-entity allow-list                                                                             | `grep` of `queryRaw`/`executeRaw`, catalog tests                                                            |
| Input validation | Zod at every controller; message length 500; body size is Express's 100 kB default                                                                                                                                              | controllers                                                                                                 |
| AI assistant     | Model output is untrusted: schema-validated, ids checked against the tenant catalog, replies from templates, confirmation held in server state, customer id never taken from text                                               | ADR-008, `assistant.int.test.ts`                                                                            |
| Abuse            | Rate limits on login (10/min per tenant+email), assistant (20/min) and customer booking creation (30/min)                                                                                                                       | integration tests for each                                                                                  |
| Response headers | `x-powered-by` off, `nosniff`, `x-frame-options: DENY`, `no-referrer`, `no-store` on the API                                                                                                                                    | `main.ts`                                                                                                   |
| Secrets          | `.env` is git-ignored; `.env.example` has no real values; the app refuses `AUTH_MODE=jwt` without a 32+ character secret; the worker's internal route is disabled without `INTERNAL_API_KEY` and compares keys in constant time | `auth.guard.ts`, `waitlist.controller.ts`                                                                   |

## Open findings

1. **Dependency advisories.** `pnpm audit --prod` reports none since the move to NestJS 11 and zod 4 (it reported 19, 9 high,
   before: `multer`, `body-parser`, and zod 3.x). `pnpm audit` including dev dependencies still reports 15, all in the
   `vitest` 2.x chain (`vitest`, `vite`, `esbuild`, `tinypool`). They affect the test runner and dev server only, never the
   production image. Fix: upgrade vitest in its own change.
2. **`AUTH_MODE=dev` is the default** so a fresh clone runs. It trusts headers and must never be exposed. The guard logs a
   warning; production configuration must set `jwt`. A safer default would break the quick start.
3. **JWT has no revocation** and lives 8 h by default; no refresh tokens, no password reset or sign-up.
4. **Rate limiters are per process** (in memory). Several API instances multiply the limits; use Redis then.
5. **Browser token storage**: the web app keeps the token in `localStorage`, readable by any XSS. There is no
   user-generated HTML rendering in the app (React escapes), and no CSP is set on the web app yet. A production build
   would use an httpOnly cookie with CSRF protection, or a backend-for-frontend.
6. **No TLS or CORS handling in the API** (a reverse proxy terminates TLS; the web app proxies `/api`, so CORS is not
   needed). Do not expose the API port directly.
7. **Hard-coded demo password** (`demo1234`) for seeded users; the seed is for local use only.
8. **No audit of the worker's AWS permissions**: it runs against LocalStack here. A real deployment needs least-privilege
   IAM for SQS/SES.
9. **Admin CRUD is generic** (`/admin/:entity`); a manager can edit any non-branch entity, including those of branches
   that are not theirs. Per-branch scoping exists for bookings and waitlist only.
