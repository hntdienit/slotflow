import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Delete,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { actingCustomer, assertBranch, Auth, type Principal } from "../auth/principal";
import { TenantId } from "../tenant.decorator";
import { WaitlistService } from "./waitlist.service";

const uuid = z.string().uuid();
const registerSchema = z.object({
  branchId: uuid,
  serviceId: uuid,
  customerId: uuid,
  staffId: uuid.optional(),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
});
const listSchema = z.object({
  branchId: uuid.optional(),
  customerId: uuid.optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const releaseSchema = z.object({
  bookingId: uuid,
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
});

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}
const id = (v: string) => parse(uuid, v);

@Controller("waitlist")
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post()
  async register(@TenantId() t: string, @Auth() p: Principal, @Body() body: unknown) {
    const input = parse(registerSchema, body);
    assertBranch(p, input.branchId);
    const out = await this.waitlist.register(t, {
      ...input,
      customerId: actingCustomer(p, input.customerId)!,
    });
    return out.entry;
  }

  @Get()
  list(@TenantId() t: string, @Auth() p: Principal, @Query() q: unknown) {
    const f = parse(listSchema, q);
    if (f.branchId) assertBranch(p, f.branchId);
    else if (p.branchIds) throw new BadRequestException("branchId is required");
    return this.waitlist.list(t, { ...f, customerId: actingCustomer(p, f.customerId) });
  }

  /** Customers see only their own entries and offers; a manager only their branches. Others look "not found". */
  private async guard(p: Principal, owner: { customerId: string; branchId: string } | null) {
    if (!owner) return;
    if (p.role === "customer" && owner.customerId !== p.customerId) throw new NotFoundException();
    if (p.branchIds && !p.branchIds.includes(owner.branchId)) throw new NotFoundException();
  }

  @Delete(":id")
  async cancel(@TenantId() t: string, @Auth() a: Principal, @Param("id") p: string) {
    await this.guard(a, await this.waitlist.entryOwner(t, id(p)));
    return this.waitlist.cancelEntry(t, id(p));
  }

  @Get("offers/:id")
  async offer(@TenantId() t: string, @Auth() a: Principal, @Param("id") p: string) {
    await this.guard(a, await this.waitlist.offerOwner(t, id(p)));
    return this.waitlist.getOffer(t, id(p));
  }

  @Post("offers/:id/accept")
  @HttpCode(200)
  async accept(
    @TenantId() t: string,
    @Auth() who: Principal,
    @Param("id") p: string,
    @Headers("x-actor") a?: string,
  ) {
    await this.guard(who, await this.waitlist.offerOwner(t, id(p)));
    return this.waitlist.accept(t, id(p), who.userId ?? a ?? "customer");
  }

  @Post("offers/:id/decline")
  @HttpCode(200)
  async decline(
    @TenantId() t: string,
    @Auth() who: Principal,
    @Param("id") p: string,
    @Headers("x-actor") a?: string,
  ) {
    await this.guard(who, await this.waitlist.offerOwner(t, id(p)));
    return this.waitlist.decline(t, id(p), who.userId ?? a ?? "customer");
  }
}

/** Service-to-service endpoints for the worker. Disabled unless INTERNAL_API_KEY is set. */
@Controller("internal/waitlist")
export class WaitlistInternalController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post("release")
  @HttpCode(200)
  release(
    @TenantId() t: string,
    @Headers("x-internal-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    const expected = process.env.INTERNAL_API_KEY;
    if (
      !expected ||
      !key ||
      key.length !== expected.length ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(expected))
    )
      throw new ForbiddenException("invalid internal key");
    const b = parse(releaseSchema, body);
    const range = b.startAt && b.endAt ? { startAt: b.startAt, endAt: b.endAt } : undefined;
    return this.waitlist.release(t, b.bookingId, range);
  }
}
