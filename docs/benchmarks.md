# Benchmarks

## Availability query (M2)

Reproduce:

```bash
export DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/slotflow_bench   # superuser, fresh database
export DATABASE_URL=postgres://slotflow_app:slotflow_app@localhost:5432/slotflow_bench
pnpm --filter @slotflow/api migrate && pnpm --filter @slotflow/api seed
pnpm --filter @slotflow/api seed:bookings && pnpm --filter @slotflow/api bench:availability
```

Result (2026-11-18):

- Machine: Intel Xeon @ 2.30 GHz × 2 vCPU, 8 GiB RAM, Node 22.23, PostgreSQL 16.15 and Redis on the
  same machine (so no network latency; expect more on separate hosts).
- Dataset: 6 branches, 30 staff, 4,689 confirmed bookings (5,537 `booking_resources` rows) over the next
  4 weeks, following real working hours, buffers and resource needs.
- Query: 7-day availability for a random branch, service and week; 400 sequential HTTP requests per row,
  after a warm-up pass.

| Scenario                         | Requests | p50 ms | p95 ms | p99 ms | Avg slots |
| -------------------------------- | -------- | ------ | ------ | ------ | --------- |
| no cache (compute from Postgres) | 400      | 6.7    | 11.3   | 13.9   | 55        |
| Redis cache hit                  | 400      | 1.1    | 1.7    | 3.9    | 55        |

Target from the plan: p95 < 100 ms. Met with a wide margin on this dataset.

Limits of this measurement: single client (no concurrency), a few thousand bookings rather than
millions, co-located services. The `booking_resources` GiST index (created by the exclusion constraint)
serves the busy-time lookup. Concurrent-load numbers (k6) arrive in M8.
