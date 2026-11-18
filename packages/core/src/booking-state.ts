export type BookingStatus =
  "held" | "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show" | "expired";

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  held: ["confirmed", "expired", "cancelled"],
  confirmed: ["checked_in", "cancelled", "no_show"],
  checked_in: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
  expired: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: BookingStatus,
    public readonly to: BookingStatus,
  ) {
    super(`Invalid booking transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
