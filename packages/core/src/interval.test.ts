import { describe, expect, it } from "vitest";
import { intersect, isFree, normalize, subtract } from "./interval";

const I = (start: number, end: number) => ({ start, end });

describe("interval algebra", () => {
  it("normalizes: sorts, merges overlapping and touching, drops empty", () => {
    expect(normalize([I(5, 8), I(1, 3), I(3, 4), I(7, 10), I(12, 12)])).toEqual([
      I(1, 4),
      I(5, 10),
    ]);
  });
  it("intersects", () => {
    expect(intersect([I(0, 10), I(20, 30)], [I(5, 25)])).toEqual([I(5, 10), I(20, 25)]);
    expect(intersect([I(0, 5)], [I(5, 9)])).toEqual([]);
  });
  it("subtracts", () => {
    expect(subtract([I(0, 10)], [I(2, 3), I(5, 7)])).toEqual([I(0, 2), I(3, 5), I(7, 10)]);
    expect(subtract([I(0, 10)], [I(-5, 4)])).toEqual([I(4, 10)]);
    expect(subtract([I(0, 10)], [I(0, 10)])).toEqual([]);
    expect(subtract([I(0, 10), I(20, 30)], [I(5, 25)])).toEqual([I(0, 5), I(25, 30)]);
  });
  it("isFree uses half-open ranges", () => {
    const busy = [I(10, 20), I(30, 40)];
    expect(isFree(busy, I(20, 30))).toBe(true);
    expect(isFree(busy, I(19, 21))).toBe(false);
    expect(isFree(busy, I(0, 10))).toBe(true);
    expect(isFree([], I(0, 1))).toBe(true);
  });
});
