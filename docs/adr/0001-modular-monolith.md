# ADR-001: Modular monolith instead of microservices

Status: accepted · 2026-11-18

## Context

SlotFlow's domains (catalog, availability, booking, waitlist, notification, assistant) share one
transactional dataset: a booking touches staff, resources, working hours and the outbox in a single
transaction. The project is built and operated by one engineer.

## Decision

One NestJS API (`apps/api`) organised into modules with explicit boundaries, plus a separate
`apps/worker` process for background jobs. Pure domain logic lives in `packages/core` with no
framework or I/O dependencies. Modules talk through service interfaces and the outbox, never through
each other's tables.

## Consequences

- Booking stays one ACID transaction; no distributed transactions or sagas for the core flow.
- Operationally simple (`docker compose up`).
- Module boundaries are kept clean so the worker or a module (e.g. notification) can be split out
  later if its scaling profile diverges. Trigger to split: independent scaling or team ownership,
  not code size.
