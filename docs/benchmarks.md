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
serves the busy-time lookup. Concurrent-load numbers (k6) are in the last section.

## Booking under contention (M3)

Reproduce (same database as above, after `seed`):

```bash
pnpm --filter @slotflow/api bench:booking
```

Result (2026-11-18, same machine as above; API, PostgreSQL and clients on one 2-vCPU box):

- Load: 1,000 `POST /bookings` from 50 concurrent clients over 20 contended (staff, time) slots, so 50 requests fight for each slot.
- Outcome: 20 × `201`, 980 × `409 SLOT_UNAVAILABLE`, no other status. Exactly 20 confirmed bookings, 0 overlapping `booking_resources` rows (the run aborts if either invariant breaks).
- Throughput 148 req/s; latency p50 305 ms, p95 512 ms, p99 908 ms. These are latencies under 50-way queueing on 2 shared vCPUs (load generator included), not single-request latency.

Integration tests assert the same invariants: 100 parallel requests for one slot give exactly one success; 1,000 requests over 50 slots give exactly 50 bookings.

## Concurrent load with k6 (M8)

Reproduce (fresh database, API built, `AUTH_MODE=dev`):

```bash
pnpm --filter @slotflow/api migrate && pnpm --filter @slotflow/api seed   # prints tenant ids
pnpm --filter @slotflow/api build && node apps/api/dist/main.js &
k6 run -e API=http://localhost:3000 -e TENANT=<tenant uuid> scripts/load/k6.js
```

Result (2026-11-19, k6 0.55, same 2 vCPU / 8 GiB machine as above; k6, API, Postgres and Redis all on it, so
they compete for the two cores and a real deployment would do better per core):

- Two scenarios at the same time for 50 s: `availability` at a ramping arrival rate up to 100 requests/s
  (one random day at one branch), and `booking`: 40 virtual users each posting a booking for a random slot out
  of a pool of 20 slots (so almost every request contends), with a fresh Idempotency-Key per request.

| Metric                                                 | Value                                   |
| ------------------------------------------------------ | --------------------------------------- |
| availability p50 / p95 / max                           | 10.1 ms / **18.2 ms** / 402 ms          |
| availability threshold (p95 < 100 ms)                  | passed                                  |
| booking attempts                                       | 9,703 (≈190/s)                          |
| created (201) / rejected for conflict (409)            | 7 / 9,696                               |
| any other status (5xx, timeout, 4xx)                   | **0** (threshold `count==0`)            |
| overlapping active `booking_resources` rows afterwards | **0** (checked with a self-join in SQL) |

Reading it: only 7 bookings fit because the pool is 20 consecutive 15-minute starts of a 30-minute service, so
accepting one blocks its neighbours; the point is that thousands of racing requests produced only clean 201/409
answers and no overlap. The booking requests themselves were not latency-checked: they queue behind the
exclusion constraint by design, and the 40 VUs saturate the two cores (overall p95 270 ms is dominated by them).

Limits: one machine, one tenant, a pool of 20 slots (a deliberately hostile shape), no network latency, and the
cache enabled for availability. Do not read the req/s as capacity: it is what two shared cores gave.
