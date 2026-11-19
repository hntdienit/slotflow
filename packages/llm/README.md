# @slotflow/llm

Turns a customer's message (Vietnamese or English) into a validated booking **extraction**. It never books anything:
the API runs the business calls (ADR-008).

- `MockProvider`: deterministic rules, offline, used by tests and `pnpm eval`.
- `AnthropicProvider`: optional real model through forced tool calling; needs `ANTHROPIC_API_KEY`.
- `validateExtraction`: Zod schema plus an allow-list (ids must come from the catalog the caller sent).

`pnpm --filter @slotflow/llm eval` prints per-field accuracy over `eval/dataset.ts`.
