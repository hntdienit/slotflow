import { BadRequestException, Controller, Get, Headers, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { TenantId } from "../tenant.decorator";
import { AvailabilityService } from "./availability.service";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const querySchema = z.object({
  serviceId: z.string().uuid(),
  from: date,
  to: date,
  staffId: z.string().uuid().optional(),
});

@Controller("branches")
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  /** Free slots for a service at a branch. `from`/`to` are branch-local dates (inclusive). */
  @Get(":id/availability")
  async get(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Query() query: Record<string, string>,
    @Headers("cache-control") cacheControl: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const branchId = z.string().uuid().safeParse(id);
    if (!branchId.success) throw new BadRequestException("branch id must be a UUID");
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { result, cache } = await this.availability.get(
      tenantId,
      { branchId: branchId.data, ...parsed.data },
      cacheControl?.includes("no-cache") ?? false,
    );
    res.setHeader("x-cache", cache);
    return result;
  }
}
