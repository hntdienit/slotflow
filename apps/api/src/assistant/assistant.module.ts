import { Module } from "@nestjs/common";
import { AnthropicProvider, MockProvider } from "@slotflow/llm";
import { AvailabilityModule } from "../availability/availability.module";
import { BookingModule } from "../booking/booking.module";
import { AssistantController } from "./assistant.controller";
import { AssistantService, LLM_PROVIDER } from "./assistant.service";

/** Real model only when a key is configured and the mock was not forced; tests and CI stay offline. */
export const providerFromEnv = () => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && process.env.ASSISTANT_PROVIDER !== "mock")
    return new AnthropicProvider({ apiKey: key, model: process.env.ASSISTANT_MODEL });
  return new MockProvider();
};

@Module({
  imports: [AvailabilityModule, BookingModule],
  controllers: [AssistantController],
  providers: [AssistantService, { provide: LLM_PROVIDER, useFactory: providerFromEnv }],
})
export class AssistantModule {}
