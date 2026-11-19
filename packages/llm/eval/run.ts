import { MockProvider } from "../src/mock";
import type { Extraction, LlmProvider } from "../src/schema";
import { validateExtraction } from "../src/schema";
import { CASES as DEV, ctxFor, type Case } from "./dataset";
import { HELD_OUT } from "./heldout";

export const FIELDS = [
  "language",
  "intent",
  "serviceId",
  "branchId",
  "date",
  "timeAfter",
  "timeBefore",
  "choice",
] as const;

export interface EvalReport {
  total: number;
  exact: number;
  perField: Record<string, number>;
  failures: { text: string; field: string; expected: unknown; got: unknown }[];
}

export async function evaluate(
  provider: LlmProvider = new MockProvider(),
  CASES: Case[] = DEV,
): Promise<EvalReport> {
  const ok: Record<string, number> = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const failures: EvalReport["failures"] = [];
  let exact = 0;
  for (const c of CASES) {
    const ctx = ctxFor(c);
    const got = validateExtraction(await provider.extract(c.text, ctx), ctx);
    let all = true;
    for (const f of FIELDS) {
      const want = (c.expect as Partial<Extraction>)[f] ?? null;
      if (got[f] === want) ok[f]++;
      else {
        all = false;
        failures.push({ text: c.text, field: f, expected: want, got: got[f] });
      }
    }
    if (all) exact++;
  }
  const perField = Object.fromEntries(FIELDS.map((f) => [f, ok[f] / CASES.length]));
  return { total: CASES.length, exact, perField, failures };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

if (process.argv[1]?.endsWith("run.ts")) {
  void (async () => {
    for (const [label, cases] of [
      ["tuned set", DEV],
      ["held-out set", HELD_OUT],
    ] as const) {
      const r = await evaluate(new MockProvider(), cases);
      console.log(`\nSlotFlow assistant eval (MockProvider), ${label}, ${r.total} cases\n`);
      console.log("| field | accuracy |\n|---|---|");
      for (const [f, v] of Object.entries(r.perField)) console.log(`| ${f} | ${pct(v)} |`);
      console.log(
        `| **all fields correct** | **${pct(r.exact / r.total)}** (${r.exact}/${r.total}) |`,
      );
      for (const x of r.failures)
        console.log(
          `  x "${x.text}": ${x.field} expected ${JSON.stringify(x.expected)} got ${JSON.stringify(x.got)}`,
        );
    }
  })();
}
