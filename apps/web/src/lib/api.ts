export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  tenantId: string;
}

/** Turns whatever Nest returned (ApiError, validation issues, plain text) into one readable line. */
export function errorMessage(status: number, body: unknown): { code?: string; message: string } {
  if (body && typeof body === "object") {
    const b = body as { code?: string; message?: unknown };
    if (typeof b.message === "string") return { code: b.code, message: b.message };
    if (Array.isArray(b.message))
      return {
        message: b.message.map((m: { message?: string }) => m.message ?? String(m)).join("; "),
      };
    if (Array.isArray(body))
      return {
        message: (body as { path?: string[]; message?: string }[])
          .map((i) => `${i.path?.join(".")}: ${i.message}`)
          .join("; "),
      };
  }
  return { message: `HTTP ${status}` };
}

export async function api<T>(
  tenantId: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      "x-tenant-id": tenantId,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = errorMessage(res.status, data);
    throw new ApiFailure(res.status, e.code, e.message);
  }
  return data as T;
}

const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

// ---- types shared by pages -----------------------------------------------------------------
export interface Branch {
  id: string;
  name: string;
  timezone: string;
  address?: string | null;
}
export interface Service {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
}
export interface Customer {
  id: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
}
export interface Staff {
  id: string;
  fullName: string;
  title?: string | null;
}
export interface Slot {
  startAt: string;
  endAt: string;
  startLocal: string;
  staffId: string;
}
export interface Booking {
  id: string;
  branchId: string;
  serviceId: string;
  customerId: string;
  status: string;
  startAt: string;
  endAt: string;
  holdExpiresAt: string | null;
  source: string;
}
export interface WaitlistEntry {
  id: string;
  branchId: string;
  serviceId: string;
  customerId: string;
  status: string;
  windowStart: string;
  windowEnd: string;
}
