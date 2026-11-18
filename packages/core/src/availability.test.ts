import { describe, expect, it } from "vitest";
import { computeAvailability, occupiedRange } from "./availability";
import { MIN } from "./interval";

const at = (h: number, m = 0) => Date.UTC(2026, 0, 5, h, m); // arbitrary UTC day
const win = (h1: number, h2: number) => ({ start: at(h1), end: at(h2) });
const svc = { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0 };
const hm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe("computeAvailability", () => {
  it("fills a window on the step grid", () => {
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 10)], busy: [] }],
      service: svc,
      stepMin: 15,
    });
    expect(slots.map((s) => hm(s.start))).toEqual(["09:00", "09:15", "09:30"]);
    expect(slots[0]!.end - slots[0]!.start).toBe(30 * MIN);
  });

  it("removes slots that overlap a booking and keeps the grid anchored to the window", () => {
    const busy = [{ start: at(9, 40), end: at(10, 10) }];
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 11)], busy }],
      service: svc,
      stepMin: 15,
    });
    expect(slots.map((s) => hm(s.start))).toEqual(["09:00", "10:15", "10:30"]);
  });

  it("buffers widen the occupied range on both sides", () => {
    const withBuf = { durationMin: 30, bufferBeforeMin: 10, bufferAfterMin: 10 };
    expect(occupiedRange(at(9, 30), withBuf)).toEqual({ start: at(9, 20), end: at(10, 10) });
    // window 09:00-10:00: first slot must leave 10 min before => 09:15; last must end 10 min before close
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 10)], busy: [] }],
      service: withBuf,
      stepMin: 15,
    });
    expect(slots.map((s) => hm(s.start))).toEqual(["09:15"]);
  });

  it("respects notBefore (minimum notice)", () => {
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 11)], busy: [] }],
      service: svc,
      stepMin: 15,
      notBefore: at(9, 50),
    });
    expect(hm(slots[0]!.start)).toBe("10:00");
  });

  it("returns nothing when the service is longer than every gap", () => {
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 10)], busy: [{ start: at(9, 20), end: at(9, 40) }] }],
      service: { ...svc, durationMin: 30 },
      stepMin: 5,
    });
    expect(slots).toEqual([]);
  });

  it("assigns the least loaded staff member and lists all options", () => {
    const slots = computeAvailability({
      staff: [
        { id: "busy-one", windows: [win(9, 12)], busy: [{ start: at(11), end: at(12) }] },
        { id: "free-one", windows: [win(9, 12)], busy: [] },
      ],
      service: svc,
      stepMin: 30,
    });
    expect(slots[0]!.staffId).toBe("free-one");
    expect(slots[0]!.staffOptions).toEqual(["free-one", "busy-one"]);
    const eleven = slots.find((s) => hm(s.start) === "11:00")!;
    expect(eleven.staffOptions).toEqual(["free-one"]); // busy-one is booked then
  });

  it("requires a free resource at the same time and balances load across resources", () => {
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 11)], busy: [] }],
      resources: [
        { id: "room-1", busy: [{ start: at(9), end: at(10) }] },
        { id: "room-2", busy: [] },
      ],
      service: svc,
      stepMin: 30,
    });
    expect(slots.map((s) => [hm(s.start), s.resourceId])).toEqual([
      ["09:00", "room-2"],
      ["09:30", "room-2"],
      ["10:00", "room-2"], // room-2 has no load => preferred over room-1
      ["10:30", "room-2"],
    ]);
  });

  it("drops a slot when no resource is free, even if staff is", () => {
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 10)], busy: [] }],
      resources: [{ id: "room-1", busy: [{ start: at(9), end: at(9, 30) }] }],
      service: svc,
      stepMin: 30,
    });
    expect(slots.map((s) => hm(s.start))).toEqual(["09:30"]);
  });

  it("handles an empty resource list as 'needs a resource but none exist'", () => {
    const slots = computeAvailability({
      staff: [{ id: "a", windows: [win(9, 10)], busy: [] }],
      resources: [],
      service: svc,
      stepMin: 30,
    });
    expect(slots).toEqual([]);
  });
});
