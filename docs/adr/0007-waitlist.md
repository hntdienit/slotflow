# ADR-007: Waitlist: FIFO offers backed by real holds

Status: accepted (M5).

## Context

When a slot frees up (cancel, reschedule, a hold that was never confirmed), people waiting for a time window should get it, fairly and without ever double-booking the slot.

## Decision

- **An offer is a real hold.** The matcher books the slot for the first waiting customer through the normal `BookingService.place` (source `waitlist`, hold of `WAITLIST_HOLD_MINUTES`, default 10) in one transaction, which also creates the `waitlist_offers` row and moves the entry `waiting` to `offered`. The exclusion constraint therefore protects an offered slot like any other booking; nothing waitlist-specific can double-book.
- **Whether a slot is free is decided by availability**, not by trusting the event, so the matcher is safe to call repeatedly and concurrently. A unique partial index allows one open offer per entry, and an entry is claimed with a conditional update, so 12 parallel releases of one slot produce one offer (tested).
- **FIFO by registration time** (`created_at`, `id`). A person who declined or let an offer lapse is skipped for that time but keeps their place for other times. An offer carries up to 3 slots inside the person's window.
- **Accept** confirms the hold (idempotent). If it lapsed, the answer is `OFFER_EXPIRED` and the slot goes to the next person. **Decline**, **leaving the queue** and **expiry** all release the slot onward.
- **The worker triggers, the API decides.** `slot.released` (cancel, reschedule: the OLD time is sent) and `booking.expired` (sweeper or lazy expiry) make the worker call `POST /internal/waitlist/release`, guarded by `INTERNAL_API_KEY` (timing-safe compare; the endpoint is disabled when the key is unset). Booking rules stay in one place; a failed call throws, so SQS retries it and finally dead-letters it (ADR-006).
- **Notification.** `waitlist.offered` (outbox) makes the worker create one notification per channel, deduplicated per offer. At delivery it is re-checked: it is only sent while the hold is still `held` and the offer is `open` and unexpired, so a late message never invites someone to a slot they can no longer take.
- **Housekeeping.** The worker closes waiting entries whose window has passed.

## Consequences

Offers are eventually consistent: a freed slot is offered within roughly the relay interval (about a second) plus queue latency. If the API is down, freed slots wait on the queue and are offered when it returns. Without `API_URL`/`INTERNAL_API_KEY` the worker skips offering (logged at startup).
