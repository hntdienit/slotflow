import { Module } from "@nestjs/common";
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
    DbModule,
    CacheModule,
    CatalogModule,
    AvailabilityModule,
    BookingModule,
    WaitlistModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
