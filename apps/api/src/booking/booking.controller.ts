import {
  BadRequestException,
  Body,
  Controller,
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

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}
const id = (v: string) => parse(uuid, v);

@Controller("bookings")
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Post("holds")
  async hold(
    @TenantId() t: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("x-actor") actor: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.place(t, body, "held", key, actor, res);
  }

  @Post()
  async create(
    @TenantId() t: string,
    @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("x-actor") actor: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.place(t, body, "confirmed", key, actor, res);
  }

  private async place(
    t: string,
    body: unknown,
    mode: "held" | "confirmed",
    key: string | undefined,
    actor: string | undefined,
    res: Response,
  ) {
    const input = parse(placeSchema, body);
    const out = await this.bookings.place(t, input, mode, key, actor ?? input.source);
    res.status(out.replay ? 200 : 201);
    if (out.replay) res.setHeader("idempotent-replay", "true");
    return out.booking;
  }

  @Get()
  list(@TenantId() t: string, @Query() q: unknown) {
    return this.bookings.list(t, parse(listSchema, q));
  }

  @Get(":id")
  get(@TenantId() t: string, @Param("id") p: string) {
    return this.bookings.get(t, id(p));
  }

  @Post(":id/confirm")
  @HttpCode(200)
  confirm(@TenantId() t: string, @Param("id") p: string, @Headers("x-actor") a?: string) {
    return this.bookings.confirm(t, id(p), a ?? "web");
  }

  @Patch(":id/reschedule")
  reschedule(
    @TenantId() t: string,
    @Param("id") p: string,
    @Body() body: unknown,
    @Headers("x-actor") a?: string,
  ) {
    const b = parse(rescheduleSchema, body);
    return this.bookings.reschedule(t, id(p), b.startAt, b.staffId, a ?? "web");
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@TenantId() t: string, @Param("id") p: string, @Headers("x-actor") a?: string) {
    return this.bookings.cancel(t, id(p), a ?? "web");
  }

  @Post(":id/check-in")
  @HttpCode(200)
  checkIn(@TenantId() t: string, @Param("id") p: string, @Headers("x-actor") a?: string) {
    return this.bookings.checkIn(t, id(p), a ?? "admin");
  }

  @Post(":id/no-show")
  @HttpCode(200)
  noShow(@TenantId() t: string, @Param("id") p: string, @Headers("x-actor") a?: string) {
    return this.bookings.noShow(t, id(p), a ?? "admin");
  }

  @Post(":id/complete")
  @HttpCode(200)
  complete(@TenantId() t: string, @Param("id") p: string, @Headers("x-actor") a?: string) {
    return this.bookings.complete(t, id(p), a ?? "admin");
  }
}
