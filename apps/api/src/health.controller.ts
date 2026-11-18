import { Controller, Get, HttpException } from "@nestjs/common";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async get() {
    const report = await this.health.check();
    if (!report.postgres) throw new HttpException(report, 503);
    return report;
  }
}
