# ADR-005: Booking lifecycle, holds and idempotency

Status: accepted (M3)

## Context

Booking must be safe under concurrency (no double booking), retry-safe (clients and the AI assistant retry), and auditable.

## Decision

- **The database decides.** `booking_resources` carries a GiST exclusion constraint (ADR-002). The availability check before an insert is advisory (it also validates working hours); a lost race surfaces as SQLSTATE `23P01`, which the service maps to the next staff × room candidate or a clean `409 SLOT_UNAVAILABLE`. There are no 500s on contention.
- **One transaction per attempt** writes the booking, _all_ its resource rows, the `booking_events` row and the outbox event. Resource rows are inserted in ascending `resource_id` order so concurrent multi-resource bookings take locks in a consistent order (no deadlocks; `40P01`/`40001` are still retried up to 4 times).
- **State machine** lives in `@slotflow/core` (`held → confirmed|expired|cancelled`, `confirmed → checked_in|cancelled|no_show`, `checked_in → completed`). Every change goes through one `transition()` helper: row lock (`FOR UPDATE`), compare-and-set on status, resource-row status, history, outbox. Invalid moves are `409 INVALID_TRANSITION`.
- **Holds** last `HOLD_MINUTES` (default 5). A constraint cannot use `now()`, so expiry is applied (a) inside every booking transaction for the affected resources and time range, (b) on confirm via `hold_expires_at > now()` evaluated by the database clock, and (c) by a sweeper worker (M4, `sweepTenant` today). A stale hold therefore never blocks a customer, even before the sweeper runs.
- **Idempotency.** `Idempotency-Key` is stored with a SHA-256 of the request. `UNIQUE (tenant_id, idempotency_key)` makes parallel duplicates collapse to one booking; the loser of the race reads the winner and replays it (`200` + `Idempotent-Replay: true`). Same key with a different payload is `422 IDEMPOTENCY_KEY_REUSED`.
- **Reschedule** is one transaction: release old rows, insert new rows, update times. A conflict rolls everything back, so the original booking is untouched. Availability is computed excluding the booking's own rows so it can shift into its own time.
- **Cancellation policy** is pure code in core (`evaluateCancellation`): free outside `cancel_window_hours`, otherwise a fee of `late_cancel_fee_percent` of the price, stored on the booking.
- **Outbox**: `booking.*` and `slot.released` events commit atomically with the change; the dispatcher (M4) delivers them. The Redis availability cache is invalidated after commit by bumping a per-branch version.

## Consequences

Correctness holds with Redis down and with any number of API instances. The cost is one extra availability read per booking and retry paths that must stay tested (`booking.int.test.ts`).
