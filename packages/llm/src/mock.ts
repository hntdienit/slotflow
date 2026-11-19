import { type Catalog, type ExtractContext, type Extraction, type LlmProvider } from "./schema";
import { addDays, detectLanguage, hhmm, localNow, normalize, pad } from "./text";

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const WEEKDAYS: [RegExp, number][] = [
  [/\b(thu hai|thu 2|monday)\b/, 0],
  [/\b(thu ba|thu 3|tuesday)\b/, 1],
  [/\b(thu tu|thu 4|wednesday)\b/, 2],
  [/\b(thu nam|thu 5|thursday)\b/, 3],
  [/\b(thu sau|thu 6|friday)\b/, 4],
  [/\b(thu bay|thu 7|saturday)\b/, 5],
  [/\b(chu nhat|sunday)\b/, 6],
];
const PARTS = {
  morning: ["06:00", "12:00"],
  noon: ["11:00", "13:00"],
  afternoon: ["12:00", "18:00"],
  evening: ["18:00", "22:00"],
} as const;

const contains = (n: string, phrase: string) => ` ${n} `.includes(` ${phrase} `);

/** Deterministic rule-based extraction. Same contract as a real model, no network, fully testable. */
export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async extract(message: string, ctx: ExtractContext): Promise<Extraction> {
    // "toi nay" / "toi mai" is an evening, not "I": keep the evening hint before the date words are removed.
    const n = normalize(message)
      .replace(/\btoi (?=nay|mai|thu|chu nhat)/g, "buoi toi ")
      .replace(/\btonight\b/g, "evening today");
    const words = n.split(" ").filter(Boolean).length;
    const language = detectLanguage(message);

    const service = matchService(n, ctx.catalog);
    const branch = matchBranch(n, ctx.catalog);
    const staff = matchStaff(n, ctx.catalog);
    const { date, rest } = parseDate(n, localNow(ctx.now, ctx.timezone));
    const { timeAfter, timeBefore } = parseTimes(rest);

    const base = {
      language,
      serviceId: service,
      branchId: branch,
      staffId: staff,
      date,
      timeAfter,
      timeBefore,
      choice: null as number | null,
    };

    const none = {
      serviceId: null,
      branchId: null,
      staffId: null,
      date: null,
      timeAfter: null,
      timeBefore: null,
      choice: null,
    };
    if (ctx.awaiting === "confirmation" && words <= 6) {
      if (
        /^(co|vang|da|dong y|ok|okay|oke|yes|yep|yeah|sure|xac nhan|chot|duoc|dat di|confirm|go ahead|book it|correct)\b/.test(
          n,
        )
      )
        return { ...none, language, intent: "confirm" };
    }
    if (ctx.awaiting && words <= 6) {
      if (/^(khong|thoi|huy|no|nope|cancel|stop|never mind|nevermind|de sau)\b/.test(n))
        return { ...none, language, intent: "decline" };
    }
    if (ctx.awaiting === "choice" && words <= 7) {
      const choice = parseChoice(n);
      if (choice) return { ...none, language, intent: "choose", choice };
    }
    const wants =
      service ||
      branch ||
      date ||
      timeAfter ||
      timeBefore ||
      /\b(dat|book|hen|lich|appointment|reserve|schedule|muon|need|want)\b/.test(n);
    return { ...base, intent: wants ? "book" : "other" };
  }
}

function matchService(n: string, cat: Catalog): string | null {
  let best: { id: string; len: number } | null = null;
  let tie = false;
  for (const s of cat.services) {
    for (const cand of [s.name, ...(s.aliases ?? [])].map(normalize)) {
      if (!cand || !contains(n, cand)) continue;
      if (!best || cand.length > best.len) {
        best = { id: s.id, len: cand.length };
        tie = false;
      } else if (cand.length === best.len && best.id !== s.id) tie = true;
    }
  }
  return best && !tie ? best.id : null;
}

/** Full name, or a distinguishing tail ("quan 1", "cau giay", "parramatta"). */
function matchBranch(n: string, cat: Catalog): string | null {
  const hits = new Set<string>();
  for (const b of cat.branches) {
    const w = normalize(b.name).split(" ");
    const keys = [w.join(" ")];
    for (let i = 1; i < w.length; i++) {
      const tail = w.slice(i);
      if (tail.length >= 2 || (tail[0]?.length ?? 0) >= 4) keys.push(tail.join(" "));
    }
    if (keys.some((k) => contains(n, k))) hits.add(b.id);
  }
  return hits.size === 1 ? ([...hits][0] ?? null) : null;
}

function matchStaff(n: string, cat: Catalog): string | null {
  const hits = (cat.staff ?? []).filter((s) => contains(n, normalize(s.name)));
  return hits.length === 1 ? (hits[0]?.id ?? null) : null;
}

function parseChoice(n: string): number | null {
  const d = n.match(/\b([123])\b/);
  if (d) return Number(d[1]);
  if (/\b(first|1st|dau tien|thu nhat|nhat|mot)\b/.test(n)) return 1;
  if (/\b(second|2nd|thu hai|hai)\b/.test(n)) return 2;
  if (/\b(third|3rd|thu ba|ba)\b/.test(n)) return 3;
  return null;
}

/** Returns the date plus the text with the date words removed (so their digits are not read as times). */
function parseDate(n: string, now: { ymd: string; weekday: number }) {
  const [Y, M] = now.ymd.split("-").map(Number) as [number, number];
  const D = Number(now.ymd.slice(8));
  const take = (re: RegExp) => {
    const m = n.match(re);
    if (m) n = n.replace(re, " ");
    return m;
  };
  const make = (y: number | undefined, mo: number, d: number): string | null => {
    let year = y ?? Y;
    let s = `${year}-${pad(mo)}-${pad(d)}`;
    if (!y && s < now.ymd) s = `${++year}-${pad(mo)}-${pad(d)}`;
    const dt = new Date(`${s}T00:00:00Z`);
    return dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d ? s : null;
  };

  n = n.replace(/\b(tuan nay|this week)\b/g, " ");
  const part = n.match(/\bthis (morning|afternoon|evening)\b/);
  if (part) n = n.replace(part[0], ` ${part[1]} today `);
  let date: string | null = null;
  if (take(/\b(day after tomorrow|ngay mot|ngay kia)\b/)) date = addDays(now.ymd, 2);
  else if (take(/\b(hom nay|today)\b|\bnay\b/)) date = now.ymd;
  else if (take(/\b(ngay mai|tomorrow|tmr|tmrw)\b|\bmai\b/)) date = addDays(now.ymd, 1);
  else {
    let m: RegExpMatchArray | null;
    if ((m = take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/)))
      date = make(m[3] ? Number(m[3]) : undefined, Number(m[2]), Number(m[1]));
    else if ((m = take(/\b(?:ngay )?(\d{1,2}) thang (\d{1,2})(?: nam (\d{4}))?\b/)))
      date = make(m[3] ? Number(m[3]) : undefined, Number(m[2]), Number(m[1]));
    else if (
      (m = take(
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* (\d{1,2})(?:st|nd|rd|th)?\b/,
      ))
    )
      date = make(undefined, MONTHS[m[1]!]!, Number(m[2]));
    else if (
      (m = take(
        /\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/,
      ))
    )
      date = make(undefined, MONTHS[m[2]!]!, Number(m[1]));
    else if ((m = take(/\bngay (\d{1,2})\b/))) {
      const day = Number(m[1]);
      date = make(undefined, day >= D ? M : M === 12 ? 1 : M + 1, day);
      if (date && day < D && M === 12) date = make(Y + 1, 1, day);
    } else {
      const next = /\b(tuan sau|tuan toi|next)\b/.test(n);
      for (const [re, wd] of WEEKDAYS) {
        if (!re.test(n)) continue;
        n = n.replace(re, " ");
        let diff = (wd - now.weekday + 7) % 7;
        if (diff === 0) diff = 7;
        if (next) diff = 7 - now.weekday + wd; // that weekday in the following Mon-Sun week
        date = addDays(now.ymd, diff);
        break;
      }
    }
  }
  return { date, rest: n.replace(/\s+/g, " ").trim() };
}

function parseTimes(n: string): { timeAfter: string | null; timeBefore: string | null } {
  // "between 9am and 11am" reads as "from 9am until 11am"
  n = n
    .replace(/\bbetween\b/g, "from")
    .replace(/\band (?=\d{1,2}(?::\d{2})? ?(?:am|pm)?\b)/g, "until ");
  const part = /\b(sang|morning)\b/.test(n)
    ? PARTS.morning
    : /\btrua\b/.test(n)
      ? PARTS.noon
      : /\b(chieu|afternoon)\b/.test(n)
        ? PARTS.afternoon
        : /\b(evening|buoi toi)\b|\b\d{1,2} ?(?:gio|h)? toi\b/.test(n)
          ? PARTS.evening
          : null;

  let after: string | null = part ? part[0] : null;
  let before: string | null = part ? part[1] : null;
  let exact = false;

  n = n.replace(/\b(before|by|until|truoc) noon\b/g, "$1 12:00");
  const re =
    /\b(after|from|sau|tu|truoc|before|by|until|den|at|luc|vao)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:(gio|h|o clock)\s*(\d{2})?)?\s*(sang|chieu|toi|trua)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(n))) {
    const [, kw, hs, ms1, ampm, unit, ms2, marker] = m;
    if (!(kw || ms1 || ampm || unit)) continue;
    let h = Number(hs);
    const min = Number(ms1 ?? ms2 ?? 0);
    if (h > 23 || min > 59) continue;
    if (ampm === "pm" && h < 12) h += 12;
    else if (ampm === "am" && h === 12) h = 0;
    else if (!ampm && h < 12) {
      if (marker === "chieu" || marker === "toi" || (part && part[0] >= "12:00" && !marker))
        h += 12;
      else if (!marker && !part && h >= 1 && h <= 6) h += 12;
    }
    const t = hhmm(h, min);
    if (kw && /^(after|from|sau|tu)$/.test(kw)) after = t;
    else if (kw && /^(truoc|before|by|until|den)$/.test(kw)) before = t;
    else {
      after = t;
      exact = true;
    }
  }
  if (exact && !/\b(truoc|before|by|until|den)\b/.test(n)) before = null;
  if (after && before && after >= before) before = null;
  return { timeAfter: after, timeBefore: before };
}
