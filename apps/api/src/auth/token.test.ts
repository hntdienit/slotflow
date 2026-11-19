import { describe, expect, it } from "vitest";
import { hashPassword, signToken, verifyPassword, verifyToken } from "./token";

const S = "x".repeat(40);
const claims = { sub: "u", tid: "t", role: "owner" as const };

describe("jwt", () => {
  it("round-trips valid tokens", () => {
    const c = verifyToken(signToken(claims, S, 60), S);
    expect(c?.sub).toBe("u");
    expect(c?.role).toBe("owner");
  });
  it("rejects expired, wrongly signed and tampered tokens", () => {
    const t = signToken(claims, S, 60, 1_000_000);
    expect(verifyToken(t, S, 1_000_000 + 61_000)).toBeNull();
    expect(verifyToken(t, "y".repeat(40), 1_000_000)).toBeNull();
    const [h, b, sig] = t.split(".") as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(b, "base64url").toString()),
        role: "owner",
        tid: "other",
      }),
    ).toString("base64url");
    expect(verifyToken(`${h}.${forged}.${sig}`, S, 1_000_000)).toBeNull();
  });
  it("rejects alg none and garbage", () => {
    const none = (a: string) =>
      `${Buffer.from(JSON.stringify({ alg: a })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, exp: 9e9 })).toString("base64url")}.`;
    expect(verifyToken(none("none"), S)).toBeNull();
    expect(verifyToken("a.b", S)).toBeNull();
    expect(verifyToken("", S)).toBeNull();
  });
});

describe("passwords", () => {
  it("verifies right and wrong passwords, and unknown users", () => {
    const h = hashPassword("demo1234");
    expect(verifyPassword("demo1234", h)).toBe(true);
    expect(verifyPassword("nope", h)).toBe(false);
    expect(verifyPassword("demo1234", null)).toBe(false);
  });
});
