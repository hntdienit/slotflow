/** Branch-local helpers: the API speaks UTC instants, people read the branch's wall clock. */
export const fmtTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(new Date(iso));

export const fmtDateTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(new Date(iso));

/** YYYY-MM-DD of an instant in a time zone. */
export const localDate = (iso: string | Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));

export const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Monday of the week containing ymd. */
export const weekStart = (ymd: string) => {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
};

export const money = (cents: number) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(cents / 100);

export const STATUS_COLOR: Record<string, string> = {
  held: "gold",
  confirmed: "blue",
  checked_in: "cyan",
  completed: "green",
  cancelled: "default",
  no_show: "red",
  expired: "default",
};

/** Which actions a booking in this status offers (mirrors the API state machine). */
export const actionsFor = (status: string): string[] =>
  status === "held"
    ? ["confirm", "cancel"]
    : status === "confirmed"
      ? ["check-in", "no-show", "cancel", "reschedule"]
      : status === "checked_in"
        ? ["complete"]
        : [];
