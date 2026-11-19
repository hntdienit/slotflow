import { BadRequestException, Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { Auth, type Principal } from "../auth/principal";
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
    @Auth() p: Principal,
    @Headers("x-customer-id") header: string | undefined,
    @Body() body: unknown,
  ) {
    // Logged in: the customer is the token's. Dev mode: the x-customer-id header.
    const cid = uuid.safeParse(p.dev ? header : p.customerId);
    if (!cid.success)
      throw new BadRequestException(
        "No customer: log in as a customer (or send x-customer-id in dev mode)",
      );
    const r = bodySchema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues);
    return this.assistant.message(tenantId, cid.data, r.data.message, r.data.conversationId);
  }
}
