import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { Principal } from "./principal";
import { type Role, verifyToken } from "./token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL: Role[] = ["owner", "manager", "staff", "customer"];
const STAFF: Role[] = ["owner", "manager", "staff"];
const ADMIN: Role[] = ["owner", "manager"];

/** First match wins. Method "*" matches any. "public" skips authentication. */
const RULES: [string, RegExp, Role[] | "public"][] = [
  ["GET", /^\/health/, "public"],
  ["*", /^\/internal\//, "public"], // service-to-service, guarded by x-internal-key
  ["POST", /^\/auth\/login$/, "public"],
  ["GET", /^\/auth\/me$/, ALL],
  ["GET", /^\/branches\/[^/]+\/availability$/, ALL],
  ["GET", /^\/admin\/customers/, STAFF],
  ["GET", /^\/admin\//, ALL],
  ["*", /^\/admin\/branches/, ["owner"]], // creating or deleting a branch is an owner decision
  ["*", /^\/admin\//, ADMIN],
  ["POST", /^\/bookings\/[^/]+\/(check-in|no-show|complete)$/, STAFF],
  ["*", /^\/bookings/, ALL], // customers are limited to their own bookings inside the controller
  ["*", /^\/waitlist/, ALL],
  ["POST", /^\/assistant\/messages$/, ["customer"]],
];

export const authMode = () => (process.env.AUTH_MODE === "jwt" ? "jwt" : "dev");

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly log = new Logger(AuthGuard.name);

  constructor() {
    if (authMode() === "jwt") {
      if ((process.env.JWT_SECRET ?? "").length < 32)
        throw new Error("AUTH_MODE=jwt needs JWT_SECRET with at least 32 characters");
    } else {
      this.log.warn(
        "AUTH_MODE=dev: tenant and customer come from headers. Never use this in production.",
      );
    }
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const path: string = String(req.path ?? req.url).split("?")[0]!;
    const rule = RULES.find(([m, re]) => (m === "*" || m === req.method) && re.test(path));

    if (authMode() === "dev") {
      const raw = req.headers["x-tenant-id"];
      const tid = Array.isArray(raw) ? raw[0] : raw;
      const cid = req.headers["x-customer-id"];
      if (rule?.[2] !== "public") {
        if (!tid || !UUID.test(tid))
          throw new UnauthorizedException("Missing or invalid x-tenant-id");
      }
      const p: Principal = {
        tenantId: tid ?? "",
        userId: null,
        role: "owner",
        customerId: typeof cid === "string" && UUID.test(cid) ? cid : null,
        branchIds: null,
        dev: true,
      };
      req.principal = p;
      return true;
    }

    // jwt mode: unknown routes are denied, not allowed by default
    if (!rule) throw new ForbiddenException("Route is not available");
    if (rule[2] === "public") return true;
    const h: string | undefined = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
    const c = token ? verifyToken(token, process.env.JWT_SECRET!) : null;
    if (!c) throw new UnauthorizedException("Missing, invalid or expired token");
    if (!rule[2].includes(c.role)) throw new ForbiddenException("Your role cannot do this");
    req.principal = {
      tenantId: c.tid,
      userId: c.sub,
      role: c.role,
      customerId: c.cid ?? null,
      branchIds: c.role === "manager" ? (c.br ?? []) : null,
      dev: false,
    } satisfies Principal;
    return true;
  }
}
