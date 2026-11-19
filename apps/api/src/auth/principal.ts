import { createParamDecorator, ExecutionContext, ForbiddenException } from "@nestjs/common";
import type { Role } from "./token";

export interface Principal {
  tenantId: string;
  userId: string | null;
  role: Role;
  customerId: string | null;
  /** null = every branch (owner, or dev mode) */
  branchIds: string[] | null;
  dev: boolean;
}

/** The authenticated caller (set by AuthGuard). In dev mode this is an all-powerful owner built from headers. */
export const Auth = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal,
);

/** A customer only ever acts as themselves; staff roles may name any customer. */
export function actingCustomer(p: Principal, requested?: string | null): string | undefined {
  if (p.role !== "customer") return requested ?? undefined;
  if (!p.customerId) throw new ForbiddenException("This account is not linked to a customer");
  if (requested && requested !== p.customerId) throw new ForbiddenException("Not your data");
  return p.customerId;
}

export function assertBranch(p: Principal, branchId: string) {
  if (p.branchIds && !p.branchIds.includes(branchId))
    throw new ForbiddenException("Not your branch");
}
