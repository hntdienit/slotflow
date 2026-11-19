import { describe, expect, it } from "vitest";
import { errorMessage } from "./api";
import { actionsFor, addDays, localDate, weekStart } from "./time";

describe("time helpers", () => {
  it("finds the Monday of a week, including Sundays", () => {
    expect(weekStart("2026-11-19")).toBe("2026-11-16"); // Thursday
    expect(weekStart("2026-11-22")).toBe("2026-11-16"); // Sunday belongs to the week before
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
  });
  it("adds days across a month end", () => expect(addDays("2026-11-29", 3)).toBe("2026-12-02"));
  it("reads the date in the branch time zone", () => {
    expect(localDate("2026-11-18T18:30:00Z", "Asia/Ho_Chi_Minh")).toBe("2026-11-19");
    expect(localDate("2026-11-18T18:30:00Z", "America/New_York")).toBe("2026-11-18");
  });
  it("offers only legal actions per status", () => {
    expect(actionsFor("held")).toEqual(["confirm", "cancel"]);
    expect(actionsFor("completed")).toEqual([]);
    expect(actionsFor("confirmed")).toContain("reschedule");
  });
});

describe("errorMessage", () => {
  it("reads ApiError, zod issue lists and unknown bodies", () => {
    expect(errorMessage(409, { code: "SLOT_UNAVAILABLE", message: "taken" })).toEqual({
      code: "SLOT_UNAVAILABLE",
      message: "taken",
    });
    expect(errorMessage(400, [{ path: ["name"], message: "Required" }]).message).toBe(
      "name: Required",
    );
    expect(errorMessage(500, null).message).toBe("HTTP 500");
  });
});
