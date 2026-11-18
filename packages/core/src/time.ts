import moment from "moment-timezone";
import { Interval, normalize } from "./interval";

/** A working-hours row: ISO weekday (1=Mon..7=Sun) and local "HH:MM" bounds. */
export interface HoursRow {
  weekday: number;
  start: string;
  end: string;
}

const hhmm = (s: string) => s.slice(0, 5);

/**
 * Converts a local window on a local calendar date to a UTC interval using the zone's rules for THAT
 * date, so daylight-saving shifts are applied correctly. A local time that does not exist (spring
 * forward) moves forward by the gap; an ambiguous one (fall back) resolves to its first occurrence.
 */
export function localWindowToUtc(
  date: string,
  tz: string,
  start: string,
  end: string,
): Interval | null {
  const s = moment.tz(`${date} ${hhmm(start)}`, "YYYY-MM-DD HH:mm", tz);
  const e = moment.tz(`${date} ${hhmm(end)}`, "YYYY-MM-DD HH:mm", tz);
  if (!s.isValid() || !e.isValid() || e.valueOf() <= s.valueOf()) return null;
  return { start: s.valueOf(), end: e.valueOf() };
}

export function isoWeekdayOf(date: string, tz: string): number {
  return moment.tz(date, "YYYY-MM-DD", tz).isoWeekday();
}

/** Inclusive list of local calendar dates "YYYY-MM-DD". */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    const d = moment.utc(from, "YYYY-MM-DD");
    d.isSameOrBefore(moment.utc(to, "YYYY-MM-DD"));
    d.add(1, "day")
  )
    out.push(d.format("YYYY-MM-DD"));
  return out;
}

/** UTC working intervals of one owner on one local date. */
export function dayWindows(date: string, tz: string, rows: readonly HoursRow[]): Interval[] {
  const wd = isoWeekdayOf(date, tz);
  const out: Interval[] = [];
  for (const r of rows) {
    if (r.weekday !== wd) continue;
    const w = localWindowToUtc(date, tz, r.start, r.end);
    if (w) out.push(w);
  }
  return normalize(out);
}

/** UTC instant of local midnight at the start of `date`. */
export function startOfLocalDay(date: string, tz: string): number {
  return moment.tz(date, "YYYY-MM-DD", tz).startOf("day").valueOf();
}

export function formatLocal(epochMs: number, tz: string): string {
  return moment.tz(epochMs, tz).format();
}

/** Local calendar date "YYYY-MM-DD" of an instant in `tz`. */
export function localDate(epochMs: number, tz: string): string {
  return moment.tz(epochMs, tz).format("YYYY-MM-DD");
}
