import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant context. M1 reads the `x-tenant-id` header (dev only); it is replaced by a JWT claim when
 * authentication lands, without changing any service code (services only receive the tenant id).
 */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const raw = ctx.switchToHttp().getRequest().headers["x-tenant-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || !UUID.test(id)) throw new UnauthorizedException("Missing or invalid x-tenant-id");
  return id;
});
