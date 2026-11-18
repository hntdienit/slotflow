import { Module } from "@nestjs/common";
import { CatalogModule } from "./catalog/catalog.module";
import { DbModule } from "./db/db.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [DbModule, CatalogModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
