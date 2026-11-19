import { HttpException, Injectable, UnauthorizedException } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { signToken, verifyPassword } from "./token";

const TTL = () => Number(process.env.JWT_TTL_SECONDS ?? 8 * 3600);

@Injectable()
export class AuthService {
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly db: DbService) {}

  async login(tenantId: string, email: string, password: string) {
    this.throttle(`${tenantId}:${email.toLowerCase()}`);
    const found = await this.db.withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { email: email.toLowerCase() } });
      const ok = verifyPassword(password, user?.passwordHash);
      if (!user || !ok) return null;
      const customer =
        user.role === "customer"
          ? await tx.customer.findFirst({ where: { userId: user.id } })
          : null;
      const branches =
        user.role === "manager"
          ? await tx.managerBranch.findMany({ where: { userId: user.id } })
          : [];
      return { user, customerId: customer?.id, branchIds: branches.map((b) => b.branchId) };
    });
    // One message for unknown tenant, unknown email and wrong password.
    if (!found) throw new UnauthorizedException("Invalid credentials");
    const role = found.user.role as "owner" | "manager" | "staff" | "customer";
    const token = signToken(
      {
        sub: found.user.id,
        tid: tenantId,
        role,
        cid: found.customerId,
        br: role === "manager" ? found.branchIds : undefined,
      },
      process.env.JWT_SECRET ?? "",
      TTL(),
    );
    return {
      token,
      expiresIn: TTL(),
      role,
      customerId: found.customerId ?? null,
      branchIds: found.branchIds,
    };
  }

  /** 10 attempts a minute per tenant+email slows password guessing without a Redis dependency. */
  private throttle(key: string) {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10)
      throw new HttpException(
        { statusCode: 429, code: "RATE_LIMITED", message: "Too many attempts" },
        429,
      );
    recent.push(now);
    this.attempts.set(key, recent);
  }
}
