import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeAvailability, occupiedRange, ServiceSpec } from "./availability";
import { Interval, MIN, normalize, overlaps } from "./interval";

// Intervals are generated on a minute grid inside a ~3.5 day span.
const interval = fc
  .tuple(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 600 }))
  .map(([s, len]): Interval => ({ start: s * MIN, end: (s + len) * MIN }));
const intervals = fc.array(interval, { maxLength: 8 });
const service = fc.record({
  durationMin: fc.integer({ min: 5, max: 120 }),
  bufferBeforeMin: fc.integer({ min: 0, max: 30 }),
  bufferAfterMin: fc.integer({ min: 0, max: 30 }),
}) satisfies fc.Arbitrary<ServiceSpec>;
const step = fc.constantFrom(5, 10, 15, 30, 60);

/** Reference implementation: test every grid point of every window directly. */
function bruteForce(
  windows: Interval[],
  busy: Interval[],
  svc: ServiceSpec,
  stepMin: number,
  notBefore: number,
) {
  const out = new Set<number>();
  for (const w of normalize(windows)) {
    for (let s = w.start; s < w.end; s += stepMin * MIN) {
      if (s < notBefore) continue;
      const occ = occupiedRange(s, svc);
      if (occ.start < w.start || occ.end > w.end) continue;
      if (normalize(busy).some((b) => overlaps(b, occ))) continue;
      out.add(s);
    }
  }
  return out;
}

describe("availability properties", () => {
  it("never returns a slot that overlaps a booking or leaves working hours, and never misses a valid one", () => {
    fc.assert(
      fc.property(
        intervals,
        intervals,
        service,
        step,
        fc.integer({ min: 0, max: 3000 }),
        (windows, busy, svc, stepMin, nb) => {
          const notBefore = nb * MIN;
          const slots = computeAvailability({
            staff: [{ id: "a", windows, busy }],
            service: svc,
            stepMin,
            notBefore,
          });
          const nw = normalize(windows);
          const nbusy = normalize(busy);
          for (const s of slots) {
            const occ = occupiedRange(s.start, svc);
            expect(nw.some((w) => w.start <= occ.start && occ.end <= w.end)).toBe(true); // inside hours
            expect(nbusy.some((b) => overlaps(b, occ))).toBe(false); // no overlap with bookings
            expect(s.start).toBeGreaterThanOrEqual(notBefore);
            expect(s.end - s.start).toBe(svc.durationMin * MIN);
          }
          // exact agreement with the brute-force reference (no false positives or negatives)
          expect(new Set(slots.map((s) => s.start))).toEqual(
            bruteForce(windows, busy, svc, stepMin, notBefore),
          );
          // strictly increasing, no duplicates
          for (let i = 1; i < slots.length; i++)
            expect(slots[i]!.start).toBeGreaterThan(slots[i - 1]!.start);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("booking a returned slot removes exactly the slots that overlap it", () => {
    fc.assert(
      fc.property(
        intervals,
        intervals,
        service,
        step,
        fc.nat(),
        (windows, busy, svc, stepMin, pick) => {
          const input = { staff: [{ id: "a", windows, busy }], service: svc, stepMin };
          const before = computeAvailability(input);
          fc.pre(before.length > 0);
          const chosen = before[pick % before.length]!;
          const occ = occupiedRange(chosen.start, svc);
          const after = computeAvailability({
            ...input,
            staff: [{ id: "a", windows, busy: [...busy, occ] }],
          });
          const expected = before
            .filter((s) => !overlaps(occupiedRange(s.start, svc), occ))
            .map((s) => s.start);
          expect(after.map((s) => s.start)).toEqual(expected);
          expect(after.some((s) => s.start === chosen.start)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("with several staff and resources, every assignment is actually free", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ windows: intervals, busy: intervals }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.array(intervals, { maxLength: 3 }),
        service,
        step,
        (staffs, resBusy, svc, stepMin) => {
          const staff = staffs.map((s, i) => ({ id: `s${i}`, ...s }));
          const resources = resBusy.map((busy, i) => ({ id: `r${i}`, busy }));
          const slots = computeAvailability({
            staff,
            resources: resBusy.length ? resources : undefined,
            service: svc,
            stepMin,
          });
          for (const slot of slots) {
            const occ = occupiedRange(slot.start, svc);
            for (const id of slot.staffOptions) {
              const s = staff.find((x) => x.id === id)!;
              expect(normalize(s.busy).some((b) => overlaps(b, occ))).toBe(false);
              expect(
                normalize(s.windows).some((w) => w.start <= occ.start && occ.end <= w.end),
              ).toBe(true);
            }
            expect(slot.staffOptions).toContain(slot.staffId);
            if (slot.resourceId) {
              const r = resources.find((x) => x.id === slot.resourceId)!;
              expect(normalize(r.busy).some((b) => overlaps(b, occ))).toBe(false);
            } else expect(resBusy.length).toBe(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
