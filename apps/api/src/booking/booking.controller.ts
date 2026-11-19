import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { actingCustomer, assertBranch, Auth, type Principal } from "../auth/principal";
import { TenantId } from "../tenant.decorator";
import { BookingService } from "./booking.service";

const uuid = z.string().uuid();
const placeSchema = z.object({
  branchId: uuid,
  serviceId: uuid,
  customerId: uuid,
  startAt: z.coerce.date(),
  staffId: uuid.optional(),
  source: z.enum(["web", "ai", "admin"]).default("web"),
});
const rescheduleSchema = z.object({ startAt: z.coerce.date(), staffId: uuid.optional() });
const listSchema = z.object({
  branchId: uuid.optional(),
  customerId: uuid.optional(),
  status: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}
const id = (v: string) => parse(uuid, v);

@Controller("bookings")
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  /** The real user id when logged in; the dev-mode header otherwise. */
  private who(p: Principal, header: string | undefined, fallback: string) {
    return p.userId ?? header ?? fallback;
  }

  /** Customers reach only their own bookings, managers only their branches; anything else looks "not found". */
  private async own(t: string, p: Principal, bookingId: string) {
    const b = await this.bookings.get(t, bookingId);
    if (p.role === "customer" && b.customerId !== p.customerId) throw new NotFoundException();
    if (p.branchIds && !p.branchIds.includes(b.branchId)) throw new NotFoundException();
    return b;
  }

  @Post("holds")
  async hold(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("x-actor") actor: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.place(t, p, body, "held", key, actor, res);
  }

  @Post()
  async create(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("x-actor") actor: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.place(t, p, body, "confirmed", key, actor, res);
  }

  private async place(
    t: string,
    p: Principal,
    body: unknown,
    mode: "held" | "confirmed",
    key: string | undefined,
    actor: string | undefined,
    res: Response,
  ) {
    const input = parse(placeSchema, body);
    assertBranch(p, input.branchId);
    input.customerId = actingCustomer(p, input.customerId)!;
    const out = await this.bookings.place(t, input, mode, key, this.who(p, actor, input.source));
    res.status(out.replay ? 200 : 201);
    if (out.replay) res.setHeader("idempotent-replay", "true");
    return out.booking;
  }

  @Get()
  list(@TenantId() t: string, @Auth() p: Principal, @Query() q: unknown) {
    const f = parse(listSchema, q);
    if (f.branchId) assertBranch(p, f.branchId);
    else if (p.branchIds) throw new BadRequestException("branchId is required");
    return this.bookings.list(t, { ...f, customerId: actingCustomer(p, f.customerId) });
  }

  @Get(":id")
  get(@TenantId() t: string, @Auth() p: Principal, @Param("id") i: string) {
    return this.own(t, p, id(i));
  }

  @Post(":id/confirm")
  @HttpCode(200)
  async confirm(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Param("id") i: string,
    @Headers("x-actor") a?: string,
  ) {
    await this.own(t, p, id(i));
    return this.bookings.confirm(t, id(i), this.who(p, a, "web"));
  }

  @Patch(":id/reschedule")
  async reschedule(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Param("id") i: string,
    @Body() body: unknown,
    @Headers("x-actor") a?: string,
  ) {
    await this.own(t, p, id(i));
    const b = parse(rescheduleSchema, body);
    return this.bookings.reschedule(t, id(i), b.startAt, b.staffId, this.who(p, a, "web"));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Param("id") i: string,
    @Headers("x-actor") a?: string,
  ) {
    await this.own(t, p, id(i));
    return this.bookings.cancel(t, id(i), this.who(p, a, "web"));
  }

  @Post(":id/check-in")
  @HttpCode(200)
  async checkIn(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Param("id") i: string,
    @Headers("x-actor") a?: string,
  ) {
    await this.own(t, p, id(i));
    return this.bookings.checkIn(t, id(i), this.who(p, a, "admin"));
  }

  @Post(":id/no-show")
  @HttpCode(200)
  async noShow(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Param("id") i: string,
    @Headers("x-actor") a?: string,
  ) {
    await this.own(t, p, id(i));
    return this.bookings.noShow(t, id(i), this.who(p, a, "admin"));
  }

  @Post(":id/complete")
  @HttpCode(200)
  async complete(
    @TenantId() t: string,
    @Auth() p: Principal,
    @Param("id") i: string,
    @Headers("x-actor") a?: string,
  ) {
    await this.own(t, p, id(i));
    return this.bookings.complete(t, id(i), this.who(p, a, "admin"));
  }
}
