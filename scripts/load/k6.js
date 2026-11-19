/* global __ENV, __VU, __ITER */
// k6 load test: availability reads under concurrency, and booking contention on a small pool of slots.
//   k6 run -e API=http://localhost:3000 -e TENANT=<tenant uuid> scripts/load/k6.js
// Assumes AUTH_MODE=dev (x-tenant-id) and a seeded database (`pnpm --filter @slotflow/api seed`).
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const API = __ENV.API || "http://localhost:3000";
const TENANT = __ENV.TENANT;
const SLOTS = Number(__ENV.SLOTS || 20); // contention pool: many users, few slots
const H = { "x-tenant-id": TENANT, "content-type": "application/json" };

const booked = new Counter("bookings_created");
const conflicts = new Counter("bookings_conflict_409");
const unexpected = new Counter("bookings_unexpected");

export const options = {
  scenarios: {
    availability: {
      executor: "ramping-arrival-rate",
      exec: "readAvailability",
      startRate: 20,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: 100, duration: "20s" },
        { target: 100, duration: "30s" },
      ],
    },
    booking: {
      executor: "constant-vus",
      exec: "book",
      vus: 40,
      duration: "50s",
      startTime: "0s",
    },
  },
  thresholds: {
    "http_req_duration{scenario:availability}": ["p(95)<100"], // target from the plan
    bookings_unexpected: ["count==0"], // only 201 or 409 are acceptable
  },
};

const get = (path) => JSON.parse(http.get(`${API}${path}`, { headers: H }).body);

export function setup() {
  const branch = get("/admin/branches").items[0];
  const service = get("/admin/services").items[0];
  const customers = get("/admin/customers?limit=200").items.map((c) => c.id);
  const days = [];
  const slots = [];
  for (let d = 1; d <= 14 && slots.length < SLOTS; d++) {
    const day = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
    days.push(day);
    const r = get(
      `/branches/${branch.id}/availability?serviceId=${service.id}&from=${day}&to=${day}`,
    );
    for (const s of r.slots)
      if (slots.length < SLOTS) slots.push({ startAt: s.startAt, staffId: s.staffId });
  }
  return { branch: branch.id, service: service.id, customers, slots, days };
}

export function readAvailability(d) {
  const day = d.days[Math.floor(Math.random() * d.days.length)];
  const res = http.get(
    `${API}/branches/${d.branch}/availability?serviceId=${d.service}&from=${day}&to=${day}`,
    { headers: H, tags: { scenario: "availability" } },
  );
  check(res, { "availability 200": (r) => r.status === 200 });
}

export function book(d) {
  const s = d.slots[Math.floor(Math.random() * d.slots.length)];
  const customer = d.customers[Math.floor(Math.random() * d.customers.length)];
  const res = http.post(
    `${API}/bookings`,
    JSON.stringify({
      branchId: d.branch,
      serviceId: d.service,
      customerId: customer,
      startAt: s.startAt,
      staffId: s.staffId,
      source: "admin",
    }),
    {
      headers: { ...H, "idempotency-key": `k6-${__VU}-${__ITER}-${Math.random()}` },
      tags: { scenario: "booking" },
      responseCallback: http.expectedStatuses(201, 409),
    },
  );
  if (res.status === 201) booked.add(1);
  else if (res.status === 409) conflicts.add(1);
  else unexpected.add(1);
}
