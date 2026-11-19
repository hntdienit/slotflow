import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";

/**
 * Tenant context. The global AuthGuard has already resolved it (JWT claim in jwt mode, `x-tenant-id` header
 * in dev mode), so services only ever receive a tenant id.
 */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const p = ctx.switchToHttp().getRequest().principal as { tenantId?: string } | undefined;
  if (p?.tenantId) return p.tenantId;
  // Public routes (internal worker calls) have no principal: they pass the tenant explicitly.
  const raw = ctx.switchToHttp().getRequest().headers["x-tenant-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id))
    throw new UnauthorizedException("Missing or invalid x-tenant-id");
  return id;
});
