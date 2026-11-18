# ADR-006: Background jobs: transactional outbox, SQS, SES

Status: accepted (M4, revised: BullMQ was replaced by SQS/SES on LocalStack at the owner's request).

## Context

Reminders (24 h and 2 h), confirmation/cancellation notices and hold expiry must survive worker crashes, follow reschedules and cancellations, and never double-send.

## Decision

- **Postgres stays the source of truth; SQS moves the work.** Booking code writes `outbox_events` in the booking transaction (ADR-005). The **relay** claims rows with `FOR UPDATE SKIP LOCKED`, sends them to the `events` queue and only then commits `dispatched_at`: a crash can duplicate a message, never lose one.
- **Events consumer.** Reads `events`, runs a handler in one transaction, then deletes the message. Handlers rebuild a booking's notifications from its CURRENT state (not the event), so duplicate, late or reordered events converge: confirmed → confirmation + `reminder_24h`/`reminder_2h` per channel; rescheduled → reminders move (a sent one is re-armed) and one notice is sent; cancelled/expired/no-show/… → unsent notifications are cancelled and a confirmed-then-cancelled booking gets one notice.
- **Delayed reminders with SQS delay.** A reminder is a `notifications` row (`scheduled_for`, unique `dedupe_key`). Every few seconds `enqueueDue` puts rows due within 15 minutes on the `notifications` queue with `DelaySeconds` = time left (SQS caps delay at 15 min, which is why only the next 15 minutes are looked ahead). `enqueued_at` makes it once per schedule; moving a reminder clears it. A stale message (reminder moved later) is dropped by the consumer; a message lost from the queue is re-enqueued once 15 minutes overdue.
- **Delivery.** The notifications consumer re-checks the notification and the booking in the database (a cancel that outran its event still suppresses the message), sends through a `NotificationChannel` and marks the row. Email goes through **SES** (v1 API; LocalStack's SES v2 is not emulated), SMS is a mock writing `sms_messages`. At-least-once: a worker that dies mid-send simply sees the message reappear after the visibility timeout.
- **Retry and dead letter are SQS features.** A failure records the error and sets an exponential visibility delay (`NOTIFY_BACKOFF_BASE_MS`); after `NOTIFY_MAX_ATTEMPTS` deliveries SQS redrives the message to the DLQ, where a small consumer marks the row `dead`. A poison event goes to the events DLQ and does not block others; inspect it with `aws sqs receive-message`.
- **Hold sweeper** is a timer in the worker: one statement expires stale holds for all tenants (booking, resource rows, history, outbox event) and bumps Redis branch versions. Correctness never depends on it (ADR-005).
- **Database role.** The worker serves every tenant, so it connects as `slotflow_worker` (`BYPASSRLS`, narrow grants, cannot write the catalog; tested).

## Why EventBridge Scheduler is not used

It would be the natural AWS tool for "run at 09:00 tomorrow", and I tried it: LocalStack 4.12 stores schedules (create/update/delete work) but never fires them, so reminders would silently not arrive in local development and CI. SQS delay plus a look-ahead works identically on LocalStack and AWS. SES v2 was dropped for the same reason (not emulated).

## LocalStack licensing

Since March 2026 the `localstack/localstack:latest` image requires an auth token (free Hobby plan for non-commercial use). Compose and CI pin `localstack/localstack:4.12.0`, the last release that does not, so `docker compose up` needs no account. The code only reads `AWS_ENDPOINT_URL`; unset it to use real AWS, or point it at another emulator.

## Consequences

- Tests (`apps/worker/test`) run against a real LocalStack SQS/SES and a real Postgres: outbox relay, duplicates, reschedule/cancel, delay, retry, DLQ, redelivery after a crash, concurrent consumers. They need LocalStack running (CI has it as a service).
- Cost: reminders are released within the poll interval of the due time (≈5 s) rather than exactly; and the pinned emulator no longer gets security updates.
- Not verified here: real AWS, and the compose file itself (no Docker in the build environment; the same LocalStack release was run natively instead).
