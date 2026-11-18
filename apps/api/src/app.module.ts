import { Module } from "@nestjs/common";
import { AvailabilityModule } from "./availability/availability.module";
import { CacheModule } from "./cache/cache.module";
import { CatalogModule } from "./catalog/catalog.module";
import { DbModule } from "./db/db.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [DbModule, CacheModule, CatalogModule, AvailabilityModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
