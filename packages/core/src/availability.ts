import { Interval, MIN, intersect, isFree, normalize, subtract, totalLength } from "./interval";

export interface ServiceSpec {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
}

export interface StaffInput {
  id: string;
  /** Working intervals (already intersected with branch hours, minus time off). */
  windows: Interval[];
  /** Occupied intervals (held-unexpired + confirmed bookings, buffers included). */
  busy: Interval[];
}

export interface ResourceInput {
  id: string;
  busy: Interval[];
}

export interface AvailabilityInput {
  staff: StaffInput[];
  /** Present only when the service needs a resource; slots need one free resource at the same time. */
  resources?: ResourceInput[];
  service: ServiceSpec;
  /** Grid step between slot starts, in minutes. */
  stepMin: number;
  /** Earliest allowed slot start (epoch ms), e.g. now + minimum notice. */
  notBefore?: number;
}

export interface Slot {
  start: number;
  end: number;
  /** Staff assigned by load balancing (least booked time first). */
  staffId: string;
  resourceId: string | null;
  /** Every resource free over the whole occupied range, least loaded first (booking tries them in order). */
  resourceOptions: string[];
  /** Every staff member who could take this slot, for "choose a specific person" UIs. */
  staffOptions: string[];
}

/** Time a booking occupies on a resource: the visible slot widened by its buffers. */
export function occupiedRange(start: number, svc: ServiceSpec): Interval {
  return {
    start: start - svc.bufferBeforeMin * MIN,
    end: start + (svc.durationMin + svc.bufferAfterMin) * MIN,
  };
}

/**
 * Slot starts for one staff member. The grid is anchored at the start of each working window
 * (09:00, 09:15, ...), so existing bookings never shift the grid; a slot is valid when its whole
 * occupied range (buffers included) fits in a free gap of the window.
 */
export function staffSlotStarts(
  windows: readonly Interval[],
  busy: readonly Interval[],
  svc: ServiceSpec,
  stepMin: number,
  notBefore = -Infinity,
): number[] {
  const step = stepMin * MIN;
  const before = svc.bufferBeforeMin * MIN;
  const span = (svc.durationMin + svc.bufferAfterMin) * MIN;
  const starts: number[] = [];
  for (const w of windows) {
    for (const free of subtract([w], busy)) {
      const earliest = Math.max(free.start + before, notBefore);
      let s = w.start + Math.ceil((earliest - w.start) / step) * step;
      for (; s + span <= free.end; s += step) starts.push(s);
    }
  }
  return starts;
}

export function computeAvailability(input: AvailabilityInput): Slot[] {
  const { service, stepMin, notBefore } = input;
  const dur = service.durationMin * MIN;
  const staff = input.staff.map((s) => ({
    id: s.id,
    windows: normalize(s.windows),
    busy: normalize(s.busy),
  }));
  const resources = input.resources?.map((r) => ({ id: r.id, busy: normalize(r.busy) }));
  const staffLoad = new Map(staff.map((s) => [s.id, totalLength(s.busy)]));
  const resourceLoad = new Map(resources?.map((r) => [r.id, totalLength(r.busy)]));

  // start -> staff ids able to take it
  const byStart = new Map<number, string[]>();
  for (const s of staff) {
    for (const start of staffSlotStarts(s.windows, s.busy, service, stepMin, notBefore)) {
      const list = byStart.get(start);
      if (list) list.push(s.id);
      else byStart.set(start, [s.id]);
    }
  }

  const byLoad =
    <T extends { id: string }>(load: Map<string, number>) =>
    (a: T, b: T) =>
      (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || (a.id < b.id ? -1 : 1);

  const slots: Slot[] = [];
  for (const start of [...byStart.keys()].sort((a, b) => a - b)) {
    const occ = occupiedRange(start, service);
    let resourceId: string | null = null;
    let resourceOptions: string[] = [];
    if (resources) {
      const free = resources.filter((r) => isFree(r.busy, occ)).sort(byLoad(resourceLoad));
      if (free.length === 0) continue;
      resourceId = free[0]!.id;
      resourceOptions = free.map((r) => r.id);
    }
    const options = byStart
      .get(start)!
      .map((id) => ({ id }))
      .sort(byLoad(staffLoad))
      .map((x) => x.id);
    slots.push({
      start,
      end: start + dur,
      staffId: options[0]!,
      resourceId,
      resourceOptions,
      staffOptions: options,
    });
  }
  return slots;
}

export { intersect, subtract, normalize };
