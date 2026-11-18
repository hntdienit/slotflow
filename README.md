# SlotFlow

Multi-branch appointment booking platform (demo domain: **medical clinics**) built to showcase
correct concurrency, multi-tenancy with timezone/DST handling, reliable background jobs and a
guarded AI booking assistant (Vietnamese + English).

> Tóm tắt (VI): SlotFlow là nền tảng đặt lịch hẹn đa chi nhánh, dữ liệu mẫu là phòng khám. Điểm nhấn:
> không bao giờ đặt trùng lịch (exclusion constraint của PostgreSQL), đa tenant bằng RLS, xử lý
> múi giờ/DST, nhắc lịch & waitlist bằng outbox + worker, trợ lý AI hỗ trợ tiếng Việt và tiếng Anh.

## Status

Milestones **M0** (scaffold), **M1** (catalog, multi-tenant RLS, seed) and **M2** (availability engine) done. Roadmap: catalog & RLS → availability engine → safe booking →
background jobs → waitlist → AI assistant → UI → polish. All data is fake.

## Quick start

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up --build   # postgres, redis, mailhog, api, worker
curl localhost:3000/health
curl -H 'x-tenant-id: <tenant uuid>' localhost:3000/admin/branches   # dev-only tenant header
curl -H 'x-tenant-id: <tenant uuid>' "localhost:3000/branches/<branch id>/availability?serviceId=<id>&from=2026-12-07&to=2026-12-13"
```

Local dev: `pnpm install` (generates the Prisma client) then `pnpm lint && pnpm typecheck && pnpm test`
(integration tests need a local PostgreSQL; set `TEST_ADMIN_URL`).

## Layout

`apps/api` (NestJS) · `apps/worker` (BullMQ) · `apps/web` (Next.js, M7) · `packages/core` (pure
domain) · `packages/llm` (assistant providers, M6) · `docs/adr` (decisions).

## Design decisions

- [ADR-001 Modular monolith](docs/adr/0001-modular-monolith.md)
- [ADR-002 Double-booking prevention](docs/adr/0002-double-booking-prevention.md)
- [ADR-003 Data access: Prisma ORM + SQL migrations](docs/adr/0003-data-access.md)
- [ADR-004 Availability engine, DST and cache](docs/adr/0004-availability-engine.md)

## Benchmarks

Availability (7-day query, 4.7k bookings): p95 11 ms from Postgres, 1.7 ms cached. Details and method in [docs/benchmarks.md](docs/benchmarks.md).
