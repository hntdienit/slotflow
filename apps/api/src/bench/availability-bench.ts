import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { PrismaPg } from "@prisma/adapter-pg";
import { localDate } from "@slotflow/core";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { AppModule } from "../app.module";
import { PrismaClient } from "../generated/prisma/client";

const N = Number(process.env.BENCH_REQUESTS ?? 400);
const pct = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL!;
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl, max: 2 }) });
  const version = (await admin.$queryRaw<{ version: string }[]>`select version()`)[0]!.version;
  const [counts] = await admin.$queryRaw<
    { bookings: bigint; booking_resources: bigint; staff: bigint; branches: bigint }[]
  >`
    select (select count(*) from bookings) bookings, (select count(*) from booking_resources) booking_resources,
           (select count(*) from staff) staff, (select count(*) from branches) branches`;
  const tenants = await admin.tenant.findMany();
  type Combo = { tenant: string; branch: string; service: string; tz: string };
  const combos: Combo[] = [];
  for (const t of tenants) {
    await admin.$transaction(async (tx) => {
      await tx.$queryRaw`select set_config('app.tenant_id', ${t.id}, true)`;
      const [branches, services] = await Promise.all([
        tx.branch.findMany({ where: { tenantId: t.id } }),
        tx.service.findMany({ where: { tenantId: t.id } }),
      ]);
      for (const b of branches)
        for (const s of services)
          combos.push({ tenant: t.id, branch: b.id, service: s.id, tz: b.timezone });
    });
  }
  await admin.$disconnect();

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;

  const run = async (label: string, noCache: boolean, warm: boolean) => {
    let seed = 7;
    const r = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const times: number[] = [];
    const slots: number[] = [];
    const plan = Array.from({ length: N }, () => {
      const c = combos[Math.floor(r() * combos.length)]!;
      const from = localDate(Date.now() + Math.floor(r() * 21) * 86_400_000, c.tz);
      const to = localDate(Date.parse(`${from}T12:00:00Z`) + 6 * 86_400_000, "UTC");
      return { c, from, to };
    });
    const call = async (p: (typeof plan)[number]) => {
      const t0 = performance.now();
      const res = await fetch(
        `${base}/branches/${p.c.branch}/availability?serviceId=${p.c.service}&from=${p.from}&to=${p.to}`,
        {
          headers: {
            "x-tenant-id": p.c.tenant,
            ...(noCache ? { "cache-control": "no-cache" } : {}),
          },
        },
      );
      const body = (await res.json()) as { slots?: unknown[] };
      if (res.status !== 200)
        throw new Error(`status ${res.status} for ${p.from}..${p.to}: ${JSON.stringify(body)}`);
      return { ms: performance.now() - t0, n: body.slots!.length, status: res.status };
    };
    if (warm) for (const p of plan) await call(p);
    for (const p of plan) {
      const o = await call(p);
      if (o.status !== 200) throw new Error(`unexpected status ${o.status}`);
      times.push(o.ms);
      slots.push(o.n);
    }
    return `| ${label} | ${N} | ${pct(times, 50).toFixed(1)} | ${pct(times, 95).toFixed(1)} | ${pct(times, 99).toFixed(1)} | ${(slots.reduce((a, b) => a + b, 0) / N).toFixed(0)} |`;
  };

  await run("warmup", true, false); // JIT and connection pool hot before measuring
  const rows = [
    await run("no cache (compute from Postgres)", true, false),
    await run("Redis cache hit", false, true),
  ];
  await app.close();

  console.log(
    `\nMachine: ${os.cpus()[0]?.model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM, Node ${process.version}, ${version.split(",")[0]}`,
  );
  console.log(
    `Dataset: ${counts!.branches} branches, ${counts!.staff} staff, ${counts!.bookings} bookings (${counts!.booking_resources} booking_resources rows)`,
  );
  console.log(
    `Query: 7-day availability, random branch/service/week in the next 4 weeks, sequential HTTP requests\n`,
  );
  console.log(
    "| Scenario | Requests | p50 ms | p95 ms | p99 ms | Avg slots |\n|---|---|---|---|---|---|",
  );
  rows.forEach((x) => console.log(x));
}
void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
