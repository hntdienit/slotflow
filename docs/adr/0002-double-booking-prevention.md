# ADR-002: Preventing double bookings with a PostgreSQL exclusion constraint

Status: accepted · 2026-11-18

## Context

Two customers can request the same staff member or room for overlapping times at nearly the same
moment. "Check availability, then insert" has a race window.

## Options considered

| Option                                         | Pros                                                          | Cons                                                            |
| ---------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Check in code, then insert                     | Simple                                                        | Race condition; unsafe                                          |
| `SELECT ... FOR UPDATE` on staff/resource rows | Correct, easy to reason about                                 | Coarse locks, contention, deadlock risk with multiple resources |
| Advisory lock per (resource, day)              | Narrow lock                                                   | Caller must get lock ordering right everywhere                  |
| **Exclusion constraint on a time range**       | Enforced by the database; cannot be bypassed by any code path | Needs `btree_gist`; violation must be handled                   |

## Decision

`booking_resources` carries `time_range tstzrange` (including buffers) and
`EXCLUDE USING gist (resource_id WITH =, time_range WITH &&) WHERE (status IN ('held','confirmed'))`.
Each resource of a booking is one row; all rows are inserted in one transaction, ordered by
`resource_id` ascending, so a conflict rolls back the whole booking and ordering prevents deadlocks.

Constraints cannot reference `now()`, so expired holds are flipped to `expired` inside the booking
transaction (for the affected resources only) and by a periodic `hold-sweeper` worker.

Requests carry an `Idempotency-Key` (unique per tenant) so retries return the original result.

## Consequences

- Correctness does not depend on Redis, locks or application code: Postgres is the source of truth.
- Constraint violation (SQLSTATE 23P01) is mapped to a clear `409 SLOT_UNAVAILABLE`.
- Proven by a test: 100 concurrent requests for one slot → exactly 1 success (M3).
