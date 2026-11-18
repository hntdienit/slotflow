import { describe, expect, it } from "vitest";
import { MIN } from "./interval";
import { canCheckIn, canMarkNoShow, evaluateCancellation } from "./policy";

const H = 60 * MIN;
const start = Date.UTC(2030, 0, 10, 9);
const base = { startAt: start, cancelWindowHours: 24, priceCents: 20000, lateFeePercent: 50 };

describe("cancellation policy", () => {
  it("is free well before the window", () => {
    expect(evaluateCancellation({ ...base, now: start - 48 * H })).toMatchObject({
      free: true,
      feeCents: 0,
    });
  });
  it("is free exactly at the window boundary", () => {
    expect(evaluateCancellation({ ...base, now: start - 24 * H }).free).toBe(true);
  });
  it("charges the late fee one minute inside the window", () => {
    expect(evaluateCancellation({ ...base, now: start - 24 * H + MIN })).toMatchObject({
      free: false,
      feeCents: 10000,
    });
  });
  it("charges after the start too, and rounds the fee", () => {
    expect(
      evaluateCancellation({ ...base, now: start + H, priceCents: 999, lateFeePercent: 33 })
        .feeCents,
    ).toBe(330);
  });
  it("a zero window means always free until the start", () => {
    expect(evaluateCancellation({ ...base, cancelWindowHours: 0, now: start - MIN }).free).toBe(
      true,
    );
    expect(evaluateCancellation({ ...base, cancelWindowHours: 0, now: start + MIN }).free).toBe(
      false,
    );
  });
});

describe("check-in and no-show windows", () => {
  const end = start + 30 * MIN;
  it("opens 60 minutes before start and closes at the end", () => {
    expect(canCheckIn(start - 61 * MIN, start, end)).toBe(false);
    expect(canCheckIn(start - 60 * MIN, start, end)).toBe(true);
    expect(canCheckIn(end - 1, start, end)).toBe(true);
    expect(canCheckIn(end, start, end)).toBe(false);
  });
  it("no-show only after the grace period", () => {
    expect(canMarkNoShow(start + 9 * MIN, start)).toBe(false);
    expect(canMarkNoShow(start + 10 * MIN, start)).toBe(true);
  });
});
