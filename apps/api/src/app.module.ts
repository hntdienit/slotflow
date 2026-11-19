import { Module } from "@nestjs/common";
import { AssistantModule } from "./assistant/assistant.module";
import { AuthModule } from "./auth/auth.module";
import { AvailabilityModule } from "./availability/availability.module";
import { BookingModule } from "./booking/booking.module";
import { CacheModule } from "./cache/cache.module";
import { CatalogModule } from "./catalog/catalog.module";
import { DbModule } from "./db/db.module";
import { WaitlistModule } from "./waitlist/waitlist.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [
    AuthModule,
    DbModule,
    CacheModule,
    CatalogModule,
    AvailabilityModule,
    BookingModule,
    WaitlistModule,
    AssistantModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
