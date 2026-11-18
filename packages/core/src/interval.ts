/** Half-open time interval [start, end) in epoch milliseconds (UTC). */
export interface Interval {
  start: number;
  end: number;
}

export const MIN = 60_000;

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sorts, drops empty intervals and merges overlapping or touching ones. */
export function normalize(xs: readonly Interval[]): Interval[] {
  const sorted = xs
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out;
}

/** Intersection of two normalized lists. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

/** `a` minus `b`; both normalized. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const x of a) {
    let cursor = x.start;
    while (j < b.length && b[j]!.end <= cursor) j++;
    let k = j;
    while (k < b.length && b[k]!.start < x.end) {
      const y = b[k]!;
      if (y.start > cursor) out.push({ start: cursor, end: y.start });
      cursor = Math.max(cursor, y.end);
      if (y.end >= x.end) break;
      k++;
    }
    if (cursor < x.end) out.push({ start: cursor, end: x.end });
  }
  return out;
}

/** True if `range` overlaps nothing in the normalized, sorted `busy` list (binary search). */
export function isFree(busy: readonly Interval[], range: Interval): boolean {
  let lo = 0;
  let hi = busy.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (busy[mid]!.end <= range.start) lo = mid + 1;
    else hi = mid;
  }
  return lo >= busy.length || busy[lo]!.start >= range.end;
}

export function totalLength(xs: readonly Interval[]): number {
  return xs.reduce((n, x) => n + (x.end - x.start), 0);
}
