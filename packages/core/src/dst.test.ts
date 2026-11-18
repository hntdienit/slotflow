import { describe, expect, it } from "vitest";
import { MIN } from "./interval";
import { computeAvailability } from "./availability";
import { dayWindows, datesBetween, formatLocal, localWindowToUtc } from "./time";

const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const SYD = "Australia/Sydney";

describe("local working hours -> UTC across DST (Sydney)", () => {
  it("normal day: 09:00-17:00 AEST (+10) is 8 real hours", () => {
    const w = localWindowToUtc("2026-09-30", SYD, "09:00", "17:00")!;
    expect(iso(w.start)).toBe("2026-09-29T23:00:00.000Z");
    expect(w.end - w.start).toBe(8 * HOUR);
  });

  it("spring forward 2026-10-04 (02:00 -> 03:00): a 00:00-06:00 shift is only 5 real hours", () => {
    const w = localWindowToUtc("2026-10-04", SYD, "00:00", "06:00")!;
    expect(w.end - w.start).toBe(5 * HOUR);
    expect(iso(w.start)).toBe("2026-10-03T14:00:00.000Z"); // 00:00 AEST (+10)
    expect(iso(w.end)).toBe("2026-10-03T19:00:00.000Z"); // 06:00 AEDT (+11)
  });

  it("fall back 2027-04-04 (03:00 -> 02:00): a 00:00-06:00 shift is 7 real hours", () => {
    const w = localWindowToUtc("2027-04-04", SYD, "00:00", "06:00")!;
    expect(w.end - w.start).toBe(7 * HOUR);
  });

  it("same local opening time lands on different UTC instants before/after the change", () => {
    const before = localWindowToUtc("2026-10-03", SYD, "08:00", "09:00")!; // AEST +10
    const after = localWindowToUtc("2026-10-05", SYD, "08:00", "09:00")!; // AEDT +11
    expect(iso(before.start)).toBe("2026-10-02T22:00:00.000Z");
    expect(iso(after.start)).toBe("2026-10-04T21:00:00.000Z");
  });

  it("a window starting inside the skipped hour starts at the first real time after it", () => {
    const w = localWindowToUtc("2026-10-04", SYD, "02:30", "04:00")!;
    expect(formatLocal(w.start, SYD)).toBe("2026-10-04T03:30:00+11:00");
    expect(w.end - w.start).toBe(30 * MIN);
  });

  it("a zone without DST (Ho Chi Minh) is stable all year", () => {
    const a = localWindowToUtc("2026-01-15", "Asia/Ho_Chi_Minh", "08:00", "17:00")!;
    const b = localWindowToUtc("2026-07-15", "Asia/Ho_Chi_Minh", "08:00", "17:00")!;
    expect(a.end - a.start).toBe(9 * HOUR);
    expect(b.end - b.start).toBe(9 * HOUR);
    expect(iso(a.start)).toBe("2026-01-15T01:00:00.000Z");
  });

  it("weekday selection follows the branch's calendar, not UTC", () => {
    // 2026-10-05 is a Monday in Sydney, though 08:00 local is still Sunday in UTC.
    const w = dayWindows("2026-10-05", SYD, [{ weekday: 1, start: "08:00", end: "09:00" }]);
    expect(w).toHaveLength(1);
    expect(iso(w[0]!.start)).toBe("2026-10-04T21:00:00.000Z");
    expect(
      dayWindows("2026-10-05", SYD, [{ weekday: 7, start: "08:00", end: "09:00" }]),
    ).toHaveLength(0);
  });

  it("hourly slots on the spring-forward night skip the missing 02:00 hour", () => {
    const w = localWindowToUtc("2026-10-04", SYD, "00:00", "06:00")!;
    const slots = computeAvailability({
      staff: [{ id: "s", windows: [w], busy: [] }],
      service: { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0 },
      stepMin: 60,
    });
    expect(slots.map((s) => formatLocal(s.start, SYD).slice(11, 16))).toEqual([
      "00:00",
      "01:00",
      "03:00",
      "04:00",
      "05:00",
    ]);
  });

  it("slots on the fall-back night include the repeated 02:00 hour", () => {
    const w = localWindowToUtc("2027-04-04", SYD, "00:00", "06:00")!;
    const slots = computeAvailability({
      staff: [{ id: "s", windows: [w], busy: [] }],
      service: { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0 },
      stepMin: 60,
    });
    expect(slots).toHaveLength(7);
  });
});

describe("dates", () => {
  it("lists inclusive local dates", () => {
    expect(datesBetween("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });
});
