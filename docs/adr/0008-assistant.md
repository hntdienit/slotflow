# ADR-008: AI booking assistant

Status: accepted

## Context

Customers should be able to book with a sentence in Vietnamese or English. A language model is good at reading the
sentence and bad at being trusted with side effects, so the design keeps it away from them.

## Decision

- **The model only extracts.** `packages/llm` turns a message into a strict Zod object (language, intent, service,
  branch, staff, date, time window, choice). Ids must exist in the tenant's catalog and times must be consistent;
  anything else is rejected and the customer is asked to rephrase. Reply text comes from fixed templates, so a model
  can never put words in the assistant's mouth.
- **Same code path as every other client.** Availability search and booking go through `AvailabilityService` and
  `BookingService.place` (source `ai`), with the same RLS, exclusion constraints and idempotency as the web UI.
- **Confirmation is server state, not a prompt.** Conversations live in `assistant_conversations` (RLS, 30 min TTL).
  A booking is created only when the stored state is `awaiting: confirmation` and the message is classified as
  `confirm`. Sending "yes" first, or forging a request, finds no pending option and creates nothing. The idempotency
  key `ai:<conversation>:<startAt>` makes a repeated "yes" return the same booking.
- **Identity never comes from text.** The customer id is the `x-customer-id` header (JWT subject once auth lands).
  Another customer's conversation id returns 404. A message naming someone else's id has no effect.
- **Prompt injection.** The message is untrusted data: the Anthropic provider wraps it in `<customer_message>` tags
  (closing tag stripped), forces a single tool call, and its output is validated like any other input. Even a fully
  hijacked model could only produce a different search; it cannot book, cancel or read other customers' data.
- **Abuse.** Message length 500, sliding-window limit per tenant+customer (`ASSISTANT_RATE_PER_MIN`, default 20, HTTP
  429). The limiter is in memory (one instance); a multi-instance deployment should move it to Redis.
- **Providers.** `MockProvider` (deterministic, offline, used in CI) or `AnthropicProvider` when `ANTHROPIC_API_KEY`
  is set. Provider errors degrade to "please rephrase", never to a guess.

## Evaluation and its limits

`pnpm eval` reports per-field accuracy. The 51-case tuned set is a regression suite for the mock. The 16-case
held-out set scored 13/16 on first run; three real parser gaps (and one wrong label of mine) were fixed, so it is
now partly tuned as well. The real model has not been measured.

## Consequences

Deliberately conservative: the assistant cannot cancel or reschedule, and asks again rather than guessing.
