# SlotFlow

Multi-branch appointment booking platform (demo domain: **medical clinics**) built to showcase
correct concurrency, multi-tenancy with timezone/DST handling, reliable background jobs and a
guarded AI booking assistant (Vietnamese + English).

> Tóm tắt (VI): SlotFlow là nền tảng đặt lịch hẹn đa chi nhánh, dữ liệu mẫu là phòng khám. Điểm nhấn:
> không bao giờ đặt trùng lịch (exclusion constraint của PostgreSQL), đa tenant bằng RLS, xử lý
> múi giờ/DST, nhắc lịch & waitlist bằng outbox + worker, trợ lý AI hỗ trợ tiếng Việt và tiếng Anh.

## Status

Milestones **M0** (scaffold), **M1** (catalog, multi-tenant RLS, seed), **M2** (availability engine) and **M3** (safe booking: holds, idempotency, reschedule, cancel policy) **M4** (outbox, reminders, hold sweeper, SQS queues with dead letters, SES email, SMS mock) **M5** (waitlist: FIFO offers backed by holds, accept/decline/expiry, notifications) and **M6** (AI booking assistant with mandatory confirmation, offline mock provider and eval set) done. Roadmap: catalog & RLS → availability engine → safe booking →
background jobs → waitlist → AI assistant → UI → polish. All data is fake.

## Quick start

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up --build   # postgres, redis, localstack (SQS+SES), api, worker
curl localhost:3000/health
curl -H 'x-tenant-id: <tenant uuid>' localhost:3000/admin/branches   # dev-only tenant header
curl -H 'x-tenant-id: <tenant uuid>' "localhost:3000/branches/<branch id>/availability?serviceId=<id>&from=2026-12-07&to=2026-12-13"
```

Local dev: `pnpm install` (generates the Prisma client) then `pnpm lint && pnpm typecheck && pnpm test`
(integration tests need a local PostgreSQL; set `TEST_ADMIN_URL`).

## Layout

`apps/api` (NestJS) · `apps/worker` (SQS/SES) · `apps/web` (Next.js, M7) · `packages/core` (pure
domain) · `packages/llm` (assistant providers, M6) · `docs/adr` (decisions).

## Design decisions

- [ADR-001 Modular monolith](docs/adr/0001-modular-monolith.md)
- [ADR-002 Double-booking prevention](docs/adr/0002-double-booking-prevention.md)
- [ADR-003 Data access: Prisma ORM + SQL migrations](docs/adr/0003-data-access.md)
- [ADR-004 Availability engine, DST and cache](docs/adr/0004-availability-engine.md)
- [ADR-005 Booking lifecycle, holds and idempotency](docs/adr/0005-booking-lifecycle.md)
- [ADR-006 Background jobs: outbox, SQS, SES](docs/adr/0006-background-jobs.md)
- [ADR-007 Waitlist: FIFO offers backed by real holds](docs/adr/0007-waitlist.md)
- [ADR-008 AI booking assistant: extraction only, server-side confirmation](docs/adr/0008-assistant.md)

## AI assistant

`POST /assistant/messages` (`x-tenant-id`, `x-customer-id`, body `{conversationId?, message}`) turns a sentence such as
"đặt cắt tóc chiều mai sau 3 giờ ở quận 1" into a search, offers up to three free slots, and books only after the
customer answers "yes" to a summary the server produced. The model only extracts parameters; it never writes to the
database. Offline by default (`MockProvider`); set `ANTHROPIC_API_KEY` to use a real model. See ADR-008.

`pnpm eval` scores extraction per field on 67 Vietnamese/English sentences:

| set                                                              | cases | all fields correct |
| ---------------------------------------------------------------- | ----- | ------------------ |
| tuned (used while building the mock)                             | 51    | 100%               |
| held-out (written afterwards; first run 13/16 = 81%, then fixed) | 16    | 100%               |

The tuned set is a regression suite for the mock, not a measure of generalisation, and the held-out set is now
partly tuned too. The real provider is only unit-tested against a fake HTTP server (no API key was available), so
its accuracy is not measured yet.

## Use-case diagrams

Interactive workflow diagrams (standalone HTML: download the file and open it in a browser; the JSON next to each is its source).

- Book safely and get reminders: [HTML](docs/diagrams/use-case-booking.html) · [JSON](docs/diagrams/use-case-booking.json)
- Cancel and offer the slot to the waitlist: [HTML](docs/diagrams/use-case-waitlist.html) · [JSON](docs/diagrams/use-case-waitlist.json)

Sơ đồ luồng use case (HTML độc lập: tải về rồi mở bằng trình duyệt; file JSON là nguồn).

## Benchmarks

Availability (7-day query, 4.7k bookings): p95 11 ms from Postgres, 1.7 ms cached. Booking under contention (1,000 requests, 20 slots, 50 clients): exactly 20 bookings, 0 overlaps, 148 req/s. Details and method in [docs/benchmarks.md](docs/benchmarks.md).
