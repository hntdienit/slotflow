import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, InvalidTransitionError } from "./booking-state.js";

describe("booking state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("held", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "checked_in")).toBe(true);
    expect(canTransition("checked_in", "completed")).toBe(true);
  });
  it("allows hold expiry, cancel and no-show", () => {
    expect(canTransition("held", "expired")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("confirmed", "no_show")).toBe(true);
  });
  it("rejects invalid transitions", () => {
    expect(canTransition("completed", "confirmed")).toBe(false);
    expect(canTransition("cancelled", "confirmed")).toBe(false);
    expect(() => assertTransition("expired", "confirmed")).toThrow(InvalidTransitionError);
  });
});
