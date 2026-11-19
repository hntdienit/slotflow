import { HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { type Catalog, type Extraction, type LlmProvider, validateExtraction } from "@slotflow/llm";
import { AvailabilityService, type SlotDto } from "../availability/availability.service";
import { ApiError, notFound } from "../booking/api-error";
import { BookingService } from "../booking/booking.service";
import { DbService } from "../db/db.service";
import { T, type Lang, type OptionView } from "./assistant.messages";

export const LLM_PROVIDER = Symbol("LLM_PROVIDER");

const MAX_OPTIONS = 3;
const SEARCH_DAYS = 7;
const RATE_PER_MIN = () => Number(process.env.ASSISTANT_RATE_PER_MIN ?? 20);

interface Option extends OptionView {
  staffId: string;
}
interface State {
  lang?: Lang;
  serviceId?: string;
  branchId?: string;
  date?: string;
  timeAfter?: string;
  timeBefore?: string;
  awaiting?: "choice" | "confirmation" | null;
  options?: Option[];
  chosen?: Option;
  done?: boolean;
}

export interface AssistantReply {
  conversationId: string;
  reply: string;
  awaiting: "choice" | "confirmation" | null;
  options: OptionView[];
  booking?: { id: string; status: string; startAt: string };
}

/**
 * The assistant never writes to the database and never talks to the booking tables itself. The model
 * only turns a message into validated parameters (packages/llm); everything else is ordinary service
 * code acting as the calling customer: availability search, then BookingService.place after an explicit
 * "yes" to a summary the server itself produced and stored.
 */
@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly db: DbService,
    private readonly availability: AvailabilityService,
    private readonly bookings: BookingService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async message(
    tenantId: string,
    customerId: string,
    text: string,
    conversationId?: string,
    now = new Date(),
  ): Promise<AssistantReply> {
    this.throttle(tenantId, customerId);
    const conv = await this.load(tenantId, customerId, conversationId, now);
    const st: State = { ...conv.state };
    const catalog = await this.catalog(tenantId);
    const branch = catalog.branches.find((b) => b.id === st.branchId) ?? catalog.branches[0];
    const ctx = {
      now: now.toISOString(),
      timezone: branch?.timezone ?? "UTC",
      catalog,
      awaiting: st.awaiting ?? null,
    };

    let ex: Extraction;
    try {
      ex = validateExtraction(await this.llm.extract(text, ctx), ctx);
    } catch (err) {
      // A provider outage or an answer that breaks the contract must never turn into a guess.
      this.log.warn(`extraction failed: ${(err as Error).message}`);
      const l = st.lang ?? "en";
      return this.save(tenantId, conv.id, st, T.rephrase(l));
    }
    // A bare "2" or "ok" carries no language evidence, so replies keep the language the conversation started in;
    // only a full request (intent book) may switch it.
    st.lang = ex.intent === "book" || !st.lang ? ex.language : st.lang;

    const out = await this.step(tenantId, customerId, conv.id, st, ex, catalog, now);
    return this.save(tenantId, conv.id, st, out.reply, out.booking);
  }

  // ---------------------------------------------------------------------------------------------

  private async step(
    tenantId: string,
    customerId: string,
    convId: string,
    st: State,
    ex: Extraction,
    catalog: Catalog,
    now: Date,
  ): Promise<{ reply: string; booking?: AssistantReply["booking"] }> {
    const lang = st.lang ?? "en";

    if (st.awaiting === "confirmation" && st.chosen) {
      if (ex.intent === "confirm") return this.book(tenantId, customerId, convId, st, catalog, now);
      if (ex.intent === "decline") return { reply: this.reset(st, lang) };
      if (ex.intent !== "book") return { reply: T.askConfirm(lang) };
      st.awaiting = null; // the customer changed the request: search again below
      st.chosen = undefined;
    } else if (st.awaiting === "choice" && st.options?.length) {
      if (ex.intent === "choose") {
        const picked = st.options[(ex.choice ?? 0) - 1];
        if (!picked) return { reply: T.askChoice(lang, st.options.length) };
        st.chosen = picked;
        st.awaiting = "confirmation";
        const { service, branch } = names(catalog, st);
        return {
          reply: T.confirm(
            lang,
            service,
            branch,
            branch ? tzOf(catalog, st) : "UTC",
            picked.startAt,
          ),
        };
      }
      if (ex.intent === "decline") return { reply: this.reset(st, lang) };
      if (ex.intent !== "book") return { reply: T.askChoice(lang, st.options.length) };
    } else if (ex.intent !== "book") {
      return { reply: T.help(lang) };
    }

    // A fresh or changed request: merge what the customer said into what we already know.
    st.serviceId = ex.serviceId ?? st.serviceId;
    st.branchId = ex.branchId ?? st.branchId;
    if (ex.date) st.date = ex.date;
    if (ex.date || ex.timeAfter || ex.timeBefore) {
      st.timeAfter = ex.timeAfter ?? (ex.date ? undefined : st.timeAfter);
      st.timeBefore = ex.timeBefore ?? (ex.date ? undefined : st.timeBefore);
    }
    if (!st.branchId && catalog.branches.length === 1) st.branchId = catalog.branches[0]!.id;
    if (!st.serviceId)
      return {
        reply: T.askService(
          lang,
          catalog.services.map((s) => s.name),
        ),
      };
    if (!st.branchId)
      return {
        reply: T.askBranch(
          lang,
          catalog.branches.map((b) => b.name),
        ),
      };
    return this.propose(tenantId, st, catalog, now);
  }

  private async propose(tenantId: string, st: State, catalog: Catalog, now: Date) {
    const lang = st.lang ?? "en";
    const tz = tzOf(catalog, st);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const from = st.date && st.date >= today ? st.date : today;
    const to = st.date && st.date >= today ? st.date : addDays(today, SEARCH_DAYS - 1);
    const { result } = await this.availability.get(tenantId, {
      branchId: st.branchId!,
      serviceId: st.serviceId!,
      from,
      to,
    });
    const slots = result.slots.filter((s) => fits(s, st, now));
    const picked = spread(slots).map<Option>((s, i) => ({
      index: i + 1,
      startAt: s.startAt,
      startLocal: s.startLocal,
      staffId: s.staffId,
    }));
    if (!picked.length) {
      st.awaiting = null;
      st.options = [];
      return { reply: T.noSlots(lang) };
    }
    st.options = picked;
    st.awaiting = "choice";
    const { service, branch } = names(catalog, st);
    return { reply: T.options(lang, service, branch, tz, picked) };
  }

  private async book(
    tenantId: string,
    customerId: string,
    convId: string,
    st: State,
    catalog: Catalog,
    now: Date,
  ) {
    const lang = st.lang ?? "en";
    const c = st.chosen!;
    try {
      const out = await this.bookings.place(
        tenantId,
        {
          branchId: st.branchId!,
          serviceId: st.serviceId!,
          customerId, // always the caller, never something taken from the message
          startAt: new Date(c.startAt),
          staffId: c.staffId,
          source: "ai",
        },
        "confirmed",
        `ai:${convId}:${c.startAt}`, // a repeated "yes" returns the same booking
        "assistant",
      );
      const b = out.booking;
      st.awaiting = null;
      st.done = true;
      const { service, branch } = names(catalog, st);
      return {
        reply: T.booked(lang, service, branch, tzOf(catalog, st), b.startAt),
        booking: { id: b.id, status: b.status, startAt: b.startAt },
      };
    } catch (err) {
      if (err instanceof ApiError && err.code === "SLOT_UNAVAILABLE") {
        st.chosen = undefined;
        const next = await this.propose(tenantId, st, catalog, now);
        return { reply: `${T.taken(lang)}\n${next.reply}` };
      }
      throw err;
    }
  }

  private reset(st: State, lang: Lang) {
    st.awaiting = null;
    st.options = [];
    st.chosen = undefined;
    return T.dismissed(lang);
  }

  // --- persistence --------------------------------------------------------------------------

  private async load(tenantId: string, customerId: string, id: string | undefined, now: Date) {
    return this.db.withTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer) throw notFound("customer");
      if (id) {
        const c = await tx.assistantConversation.findUnique({ where: { id } });
        // Someone else's conversation looks exactly like a missing one.
        if (!c || c.customerId !== customerId || c.expiresAt < now) throw notFound("conversation");
        return { id: c.id, state: c.state as unknown as State };
      }
      const c = await tx.assistantConversation.create({
        data: { customerId, expiresAt: new Date(now.getTime() + 30 * 60_000) },
      });
      return { id: c.id, state: {} as State };
    });
  }

  private async save(
    tenantId: string,
    id: string,
    st: State,
    reply: string,
    booking?: AssistantReply["booking"],
  ): Promise<AssistantReply> {
    await this.db.withTenant(tenantId, (tx) =>
      tx.assistantConversation.update({
        where: { id },
        data: {
          state: st as object,
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      }),
    );
    return {
      conversationId: id,
      reply,
      awaiting: st.awaiting ?? null,
      options:
        st.awaiting === "choice"
          ? (st.options ?? []).map(({ index, startAt, startLocal }) => ({
              index,
              startAt,
              startLocal,
            }))
          : [],
      ...(booking ? { booking } : {}),
    };
  }

  private async catalog(tenantId: string) {
    return this.db.withTenant(tenantId, async (tx) => {
      const [services, branches] = await Promise.all([
        tx.service.findMany({ orderBy: { name: "asc" }, take: 100 }),
        tx.branch.findMany({ orderBy: { name: "asc" }, take: 100 }),
      ]);
      return {
        services: services.map((s) => ({ id: s.id, name: s.name })),
        branches: branches.map((b) => ({ id: b.id, name: b.name, timezone: b.timezone })),
      };
    });
  }

  /** Sliding window per customer: the assistant is the cheapest endpoint to hammer. */
  private throttle(tenantId: string, customerId: string) {
    const key = `${tenantId}:${customerId}`;
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= RATE_PER_MIN())
      throw new HttpException(
        { statusCode: 429, code: "RATE_LIMITED", message: T.tooMany("en") },
        429,
      );
    recent.push(now);
    this.hits.set(key, recent);
  }
}

// --- pure helpers --------------------------------------------------------------------------

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const tzOf = (c: Catalog, st: State) =>
  c.branches.find((b) => b.id === st.branchId)?.timezone ?? "UTC";

const names = (c: Catalog, st: State) => ({
  service: c.services.find((s) => s.id === st.serviceId)?.name ?? "",
  branch: c.branches.find((b) => b.id === st.branchId)?.name ?? "",
});

/** Slot is in the future and inside the customer's time window (branch-local HH:mm). */
function fits(s: SlotDto, st: State, now: Date): boolean {
  if (new Date(s.startAt).getTime() <= now.getTime()) return false;
  const hm = s.startLocal.slice(11, 16);
  if (st.timeAfter && hm < st.timeAfter) return false;
  if (st.timeBefore && hm > st.timeBefore) return false;
  return true;
}

/**
 * Up to three options: the earliest slot of each of the next days first, so the choice is not three
 * near-identical times; if the customer asked for one day, the earliest slots of that day.
 */
function spread(slots: SlotDto[]): SlotDto[] {
  const sorted = [...slots].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const days = new Set<string>();
  const firsts: SlotDto[] = [];
  const rest: SlotDto[] = [];
  for (const s of sorted) {
    const day = s.startLocal.slice(0, 10);
    if (days.has(day)) rest.push(s);
    else {
      days.add(day);
      firsts.push(s);
    }
  }
  return [...firsts, ...rest]
    .slice(0, MAX_OPTIONS)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}
