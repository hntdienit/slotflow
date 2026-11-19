# ADR-009: Authentication and authorization

Status: accepted

## Context

Until M7 the tenant came from an `x-tenant-id` header, which anyone can set. A real deployment needs identity, roles
and per-branch limits, without rewriting the services (they only ever receive a tenant id).

## Decision

- **Two modes, chosen by `AUTH_MODE`.** `dev` (default, used by tests, the simulator and the demo) trusts
  `x-tenant-id` / `x-customer-id`, and logs a warning at startup. `jwt` requires `Authorization: Bearer` on every
  route except health, login and the worker's internal route (which has its own shared secret). In `jwt` mode the
  header is ignored entirely and the app refuses to start without a 32+ character `JWT_SECRET`.
- **HS256 on `node:crypto`**, about 40 lines, no JWT library to audit. The algorithm is fixed by the verifier, never read
  from the token (no `alg: none`, no key confusion); signatures are compared in constant time; `exp` is mandatory.
  Claims: `sub`, `tid` (tenant), `role`, `cid` (customer id), `br` (a manager's branches).
- **Passwords** with scrypt and a per-user salt. Login returns the same error for an unknown tenant, unknown email and
  wrong password, always does one scrypt (no timing difference), and allows 10 attempts a minute per tenant+email.
- **One rule table in a global guard** maps method + path to the roles that may call it; a route that is not in the
  table is denied in `jwt` mode. Roles: `owner` (everything), `manager` (admin except creating/deleting branches, only
  assigned branches), `staff` (read, check-in, no-show, complete), `customer` (own bookings, own waitlist entries and
  the assistant).
- **Row-level checks live in the controllers**: a customer always acts as themselves (`actingCustomer`), a manager is
  limited to `br` (`assertBranch`), and someone else's booking or offer answers 404, not 403, so ids cannot be probed.
- **The tenant boundary does not depend on any of this.** Postgres RLS still isolates tenants; the token only decides
  which tenant id the request carries.
- Customers are limited to 30 booking creations a minute (`BOOKING_RATE_PER_MIN`).

## Consequences

- Tokens are not revocable before expiry (8 h by default). Fine for a demo; a product needs a short TTL plus refresh
  tokens, or a deny-list.
- `dev` mode must never face the internet. The default is `dev` so that the clone-and-run experience works; a
  production deployment sets `AUTH_MODE=jwt` and the guard enforces the secret.
- Rate limiters (login, bookings, assistant) are in memory: correct for one instance, per-instance with several. Move
  them to Redis when the API scales out.
- Staff and customers have no sign-up or password-reset flow; users come from the seed or the database.
