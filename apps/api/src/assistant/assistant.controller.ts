import { BadRequestException, Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { TenantId } from "../tenant.decorator";
import { AssistantService } from "./assistant.service";

const uuid = z.string().uuid();
const bodySchema = z.object({
  conversationId: uuid.optional(),
  message: z.string().trim().min(1).max(500),
});

@Controller("assistant")
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  /**
   * The customer is identified by `x-customer-id` (dev header, replaced by the JWT subject with auth),
   * never by anything in the message text.
   */
  @Post("messages")
  @HttpCode(200)
  message(
    @TenantId() tenantId: string,
    @Headers("x-customer-id") customerId: string | undefined,
    @Body() body: unknown,
  ) {
    const cid = uuid.safeParse(customerId);
    if (!cid.success) throw new BadRequestException("Missing or invalid x-customer-id");
    const r = bodySchema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues);
    return this.assistant.message(tenantId, cid.data, r.data.message, r.data.conversationId);
  }
}
