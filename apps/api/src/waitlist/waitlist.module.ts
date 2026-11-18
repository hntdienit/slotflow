import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module";
import { BookingModule } from "../booking/booking.module";
import { WaitlistController, WaitlistInternalController } from "./waitlist.controller";
import { WaitlistService } from "./waitlist.service";

@Module({
  imports: [AvailabilityModule, BookingModule],
  controllers: [WaitlistController, WaitlistInternalController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
