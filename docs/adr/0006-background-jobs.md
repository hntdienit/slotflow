# ADR-006: Background jobs on Postgres (outbox, delivery, sweeper)

Status: accepted (M4). Deviates from the plan, which named BullMQ delayed jobs; see "Why not BullMQ".

## Context

Reminders (24 h and 2 h), confirmation/cancellation notices and hold expiry must survive worker crashes, must follow reschedules and cancellations, and must never double-send.

## Decision

- **Transactional outbox.** Booking code writes `outbox_events` in the same transaction as the state change (ADR-005). The dispatcher claims batches with `FOR UPDATE SKIP LOCKED` (any number of workers), runs each handler in a savepoint and marks the event dispatched in the same transaction. A crash rolls the batch back and it is claimed again.
- **Handlers converge on current state.** `syncBookingNotifications` reads the booking as it is now, not the event payload, so duplicate, late or reordered events give the same result. Confirmed: confirmation plus `reminder_24h`/`reminder_2h` per channel the customer has. Rescheduled: reminders move to the new time (a sent one is re-armed) and one notice is sent. Cancelled/expired/no-show/…: unsent notifications become `cancelled`; a cancelled booking that had been confirmed gets one notice.
- **Notifications are the scheduler.** A reminder is a `notifications` row with `scheduled_for`. Delivery polls due rows, so "delayed jobs" need no second store. `dedupe_key` (`booking:<id>:<type>:<channel>`, unique per tenant) prevents duplicates; moving a reminder is an update of its row.
- **Delivery with a lease.** A row is claimed by setting `locked_until` (no transaction held during network I/O). A crashed worker's lease expires and the row is retried. Delivery is at-least-once; the email carries a stable `Message-ID` and the SMS mock has a unique row per notification, so a re-send is harmless. Before sending, the booking is re-checked, so a cancel that raced ahead of its event still suppresses the message.
- **Retry and dead letter.** Exponential backoff (`NOTIFY_BACKOFF_BASE_MS`, default 5 s), `NOTIFY_MAX_ATTEMPTS` (default 5), then `status = 'dead'` with `last_error`. Outbox events that keep failing get `dead_at` and do not block the events behind them. Dead rows are the dead-letter queue: inspect with `SELECT … WHERE status = 'dead'`, requeue by resetting status and attempts.
- **Channels** implement `NotificationChannel`: Email via Nodemailer to MailHog, SMS mock writing `sms_messages`.
- **Hold sweeper** expires stale holds across tenants in one statement (booking, resource rows, history, outbox event) and bumps the Redis branch versions. It only tidies up: correctness never depends on it (ADR-005).
- **Database role.** The worker serves every tenant, so it connects as `slotflow_worker`: `BYPASSRLS` but with narrow grants (read catalog, update bookings/notifications/outbox, no catalog writes, no DDL). A test asserts it cannot insert services.

## Why not BullMQ

Delayed jobs in Redis would be a second source of truth that has to be kept in step with bookings, and an unflushed Redis would silently lose reminders. With rows in Postgres, scheduling is atomic with the booking, cancel/reschedule is an ordinary update, and recovery after a crash is a query. The cost is polling (1–2 s) instead of push, which is fine for reminders; throughput is bounded by Postgres, and a queue can be introduced later behind the same handlers if volume demands it. The `bullmq` dependency was removed from the worker.

## Consequences

Everything above is tested against a real database (`apps/worker/test`), including concurrent dispatchers, crash leases, retries and dead-lettering. The SMTP adapter is exercised only against MailHog by hand, not in automated tests.
