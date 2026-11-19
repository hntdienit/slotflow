import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Minimal HS256 JWT and scrypt password hashing on node:crypto: no extra dependency to audit. */

export type Role = "owner" | "manager" | "staff" | "customer";
export interface Claims {
  sub: string; // user id
  tid: string; // tenant id
  role: Role;
  cid?: string; // customer id (customers only)
  br?: string[]; // branch ids a manager may act on
  iat: number;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (data: string, secret: string) =>
  createHmac("sha256", secret).update(data).digest("base64url");

export function signToken(
  c: Omit<Claims, "iat" | "exp">,
  secret: string,
  ttlSec: number,
  now = Date.now(),
) {
  const iat = Math.floor(now / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ ...c, iat, exp: iat + ttlSec }));
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

/** Returns the claims, or null for anything malformed, forged, wrongly signed or expired. */
export function verifyToken(token: string, secret: string, now = Date.now()): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  try {
    // The algorithm is fixed by us, never read from the token ("alg: none" and key-confusion attacks).
    if ((JSON.parse(Buffer.from(head, "base64url").toString()) as { alg?: string }).alg !== "HS256")
      return null;
    const expected = Buffer.from(sign(`${head}.${body}`, secret));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
    if (typeof c.exp !== "number" || c.exp * 1000 <= now) return null;
    if (!c.sub || !c.tid || !["owner", "manager", "staff", "customer"].includes(c.role))
      return null;
    return c;
  } catch {
    return null;
  }
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(pw, salt, 32).toString("base64")}`;
}

const DUMMY = hashPassword("not-a-real-password");
/** Always does one scrypt, even for an unknown user, so response time does not reveal which emails exist. */
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  const [, salt, hash] = (stored ?? DUMMY).split("$");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(pw, Buffer.from(salt, "base64"), want.length);
  return stored ? timingSafeEqual(want, got) : false;
}
