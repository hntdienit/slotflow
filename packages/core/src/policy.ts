import { MIN } from "./interval";

const HOUR = 60 * MIN;

export interface CancellationInput {
  /** Appointment start, epoch ms. */
  startAt: number;
  now: number;
  /** Free cancellation until this many hours before the start. */
  cancelWindowHours: number;
  priceCents: number;
  /** Share of the price kept when cancelling late (simulated deposit). */
  lateFeePercent: number;
}

export interface CancellationResult {
  free: boolean;
  feeCents: number;
  hoursBeforeStart: number;
}

/** Cancelling at least `cancelWindowHours` before the start (boundary included) is free. */
export function evaluateCancellation(i: CancellationInput): CancellationResult {
  const hoursBeforeStart = (i.startAt - i.now) / HOUR;
  const free = hoursBeforeStart >= i.cancelWindowHours;
  const feeCents = free ? 0 : Math.round((i.priceCents * i.lateFeePercent) / 100);
  return { free, feeCents, hoursBeforeStart };
}

export const CHECK_IN_OPENS_MIN_BEFORE = 60;
export const NO_SHOW_GRACE_MIN = 10;

/** Check-in is accepted from 60 minutes before the start until the appointment ends. */
export function canCheckIn(now: number, startAt: number, endAt: number): boolean {
  return now >= startAt - CHECK_IN_OPENS_MIN_BEFORE * MIN && now < endAt;
}

/** A no-show can be recorded once the grace period after the start has passed. */
export function canMarkNoShow(now: number, startAt: number): boolean {
  return now >= startAt + NO_SHOW_GRACE_MIN * MIN;
}
