import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import { AuthService } from "./auth.service";
import { authMode } from "./auth.guard";
import { Auth, type Principal } from "./principal";

const loginSchema = z.object({
  tenantId: z.string().uuid(),
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown) {
    if (authMode() !== "jwt")
      throw new ServiceUnavailableException("AUTH_MODE is dev: no login needed");
    const r = loginSchema.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues);
    return this.auth.login(r.data.tenantId, r.data.email, r.data.password);
  }

  @Get("me")
  me(@Auth() p: Principal) {
    return {
      tenantId: p.tenantId,
      userId: p.userId,
      role: p.role,
      customerId: p.customerId,
      branchIds: p.branchIds,
    };
  }
}
