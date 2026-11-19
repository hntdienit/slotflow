import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const INTENTS = ["book", "choose", "confirm", "decline", "other"] as const;
export type Intent = (typeof INTENTS)[number];

/** What a provider may return. Everything else the model says is thrown away. */
export const ExtractionSchema = z
  .object({
    language: z.enum(["vi", "en"]),
    intent: z.enum(INTENTS),
    serviceId: z.string().uuid().nullable(),
    branchId: z.string().uuid().nullable(),
    staffId: z.string().uuid().nullable().default(null),
    /** Branch-local calendar date, YYYY-MM-DD. */
    date: ymd.nullable(),
    timeAfter: hhmm.nullable(),
    timeBefore: hhmm.nullable(),
    /** 1-based index of a proposed option. */
    choice: z.number().int().min(1).max(3).nullable(),
  })
  .strict();
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface Catalog {
  services: { id: string; name: string; aliases?: string[] }[];
  branches: { id: string; name: string; timezone: string }[];
  staff?: { id: string; name: string }[];
}

export interface ExtractContext {
  /** ISO instant used to resolve "tomorrow", weekdays, ... */
  now: string;
  /** Time zone of the branch the customer is talking about (or the default one). */
  timezone: string;
  catalog: Catalog;
  /** What the assistant just asked, so a bare "2" or "ok" is read correctly. */
  awaiting: "choice" | "confirmation" | null;
}

export interface LlmProvider {
  readonly name: string;
  extract(message: string, ctx: ExtractContext): Promise<unknown>;
}

export class ExtractionError extends Error {}

/**
 * Never trust a provider: the shape is checked with Zod, ids must belong to the catalog the caller
 * sent (so injected text cannot name another tenant's service), and ranges must make sense.
 */
export function validateExtraction(raw: unknown, ctx: ExtractContext): Extraction {
  const r = ExtractionSchema.safeParse(raw);
  if (!r.success) throw new ExtractionError(`invalid extraction: ${r.error.issues[0]?.message}`);
  const e = r.data;
  const known = <T extends { id: string }>(list: T[] | undefined, id: string | null) =>
    id === null || !!list?.some((x) => x.id === id);
  if (!known(ctx.catalog.services, e.serviceId)) throw new ExtractionError("unknown serviceId");
  if (!known(ctx.catalog.branches, e.branchId)) throw new ExtractionError("unknown branchId");
  if (!known(ctx.catalog.staff, e.staffId)) throw new ExtractionError("unknown staffId");
  if (e.timeAfter && e.timeBefore && e.timeAfter >= e.timeBefore)
    throw new ExtractionError("timeAfter must be before timeBefore");
  if (e.date && Number.isNaN(Date.parse(`${e.date}T00:00:00Z`)))
    throw new ExtractionError("invalid date");
  if (e.intent === "choose" && e.choice === null) throw new ExtractionError("choose needs choice");
  return e;
}
