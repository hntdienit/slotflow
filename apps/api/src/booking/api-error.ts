import { HttpException } from "@nestjs/common";

/** Error with a stable machine-readable `code`, so clients (and the AI assistant) can react to it. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ statusCode: status, code, message, ...extra }, status);
  }
}

export const slotUnavailable = () =>
  new ApiError(
    409,
    "SLOT_UNAVAILABLE",
    "That time is no longer available. Please pick another slot.",
  );
export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const invalidTransition = (from: string, to: string) =>
  new ApiError(409, "INVALID_TRANSITION", `Cannot change a booking from ${from} to ${to}`, {
    from,
    to,
  });
