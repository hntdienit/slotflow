# ADR-004: Availability engine — pure core, local-time hours, versioned Redis cache

Status: accepted · 2026-11-18

## Context

Availability must be correct across time zones and daylight-saving changes, fast enough for a public
booking page, and must never be the thing that prevents a double booking (that is ADR-002's job).

## Decision

- **Pure engine in `packages/core`.** `computeAvailability` takes intervals (epoch ms) and returns slots;
  it does no I/O. The API loads data (Prisma), builds intervals, calls the engine. This makes the
  algorithm unit-testable, property-testable and benchmarkable in isolation.
- **Algorithm.** Per staff member: working windows (branch hours ∩ staff hours − time off), minus busy
  intervals; slots are grid points (15 min by default) whose whole _occupied range_
  `[start − bufferBefore, start + duration + bufferAfter)` fits in a free gap. If the service needs a
  resource (room, chair), a slot also needs one resource free over that same range. Staff and resources
  are assigned by least booked time (load balancing); all staff able to take the slot are returned too.
- **Grid anchored to the working window**, not to the free gap, so an existing booking never shifts other
  slots (09:00, 09:15, ... stays stable).
- **Time zones with moment-timezone** (author's choice). Instants are UTC; working hours are stored as
  local `time` per weekday and converted _per calendar date_ with the branch's IANA zone, so each date
  uses the offset in force on that date. A local time that does not exist (spring forward) moves
  forward by the gap; an ambiguous one (fall back) takes its first occurrence. Tests cover Sydney
  spring-forward (5 real hours in a 00:00–06:00 shift), fall-back (7 hours), weekday boundaries that
  differ from UTC, and a zone without DST.
- **Cache.** Redis, 60 s TTL. Keys embed two version counters (`ver:cat:{tenant}` for catalog changes,
  `ver:br:{tenant}:{branch}` for bookings); bumping a counter invalidates every dependent entry in O(1).
  Catalog mutations bump the tenant counter; the booking service (M3) must bump the branch counter.
  Every Redis error is treated as a miss, so losing Redis only costs speed (tested). Clients can send
  `Cache-Control: no-cache` to bypass; responses carry `x-cache: hit|miss|bypass`.
- **Held bookings** whose `hold_expires_at` has passed are ignored when computing busy time (the
  exclusion constraint cannot use `now()`; see ADR-002).

## Consequences

- Availability is advisory: a slot shown may be taken a moment later. The database exclusion
  constraint is what guarantees no double booking, and the booking API returns a clear 409.
- Staleness is bounded by 60 s, and by invalidation on every catalog or booking change.
- Property tests (fast-check) compare the engine against a brute-force reference and assert: no slot
  overlaps a booking, none leaves working hours, none is missed, and booking a slot removes exactly the
  slots that overlap it.
