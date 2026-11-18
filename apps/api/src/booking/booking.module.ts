import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module";
import { BookingController } from "./booking.controller";
import { BookingService } from "./booking.service";

@Module({
  imports: [AvailabilityModule],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
