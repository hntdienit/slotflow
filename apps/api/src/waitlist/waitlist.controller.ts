import {
  BadRequestException,
  Body,
  Controller,
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

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException(r.error.issues);
  return r.data;
}
const id = (v: string) => parse(uuid, v);

@Controller("waitlist")
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post()
  async register(@TenantId() t: string, @Body() body: unknown) {
    const out = await this.waitlist.register(t, parse(registerSchema, body));
    return out.entry;
  }

  @Get()
  list(@TenantId() t: string, @Query() q: unknown) {
    return this.waitlist.list(t, parse(listSchema, q));
  }

  @Delete(":id")
  cancel(@TenantId() t: string, @Param("id") p: string) {
    return this.waitlist.cancelEntry(t, id(p));
  }

  @Get("offers/:id")
  offer(@TenantId() t: string, @Param("id") p: string) {
    return this.waitlist.getOffer(t, id(p));
  }

  @Post("offers/:id/accept")
  @HttpCode(200)
  accept(@TenantId() t: string, @Param("id") p: string, @Headers("x-actor") a?: string) {
    return this.waitlist.accept(t, id(p), a ?? "customer");
  }

  @Post("offers/:id/decline")
  @HttpCode(200)
  decline(@TenantId() t: string, @Param("id") p: string, @Headers("x-actor") a?: string) {
    return this.waitlist.decline(t, id(p), a ?? "customer");
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
