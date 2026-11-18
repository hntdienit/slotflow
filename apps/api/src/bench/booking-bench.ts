import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { PrismaPg } from "@prisma/adapter-pg";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { AppModule } from "../app.module";
import { PrismaClient } from "../generated/prisma/client";

const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 1000);
const SLOTS = Number(process.env.BENCH_SLOTS ?? 50);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 50);
const pct = (xs: number[], p: number) =>
  xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

/** Books the same set of contended slots many times over; exactly one request per slot may win. */
async function main() {
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_ADMIN_URL!, max: 2 }),
  });
  const version = (await admin.$queryRaw<{ version: string }[]>`select version()`)[0]!.version;
  const tenant = (await admin.tenant.findFirstOrThrow({ orderBy: { slug: "asc" } })).id;
  const { branch, service, customer } = await admin.$transaction(async (tx) => {
    await tx.$queryRaw`select set_config('app.tenant_id', ${tenant}, true)`;
    const sb = await tx.staffBranch.findFirstOrThrow({ where: { tenantId: tenant } });
    const ss = await tx.staffService.findFirstOrThrow({
      where: { staffId: sb.staffId, tenantId: tenant },
    });
    const cus = await tx.customer.findFirstOrThrow({ where: { tenantId: tenant } });
    return { branch: sb.branchId, service: ss.serviceId, customer: cus.id };
  });

  const app = await NestFactory.create(AppModule, { logger: ["error"] });
  await app.listen(0);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  const h = { "x-tenant-id": tenant, "content-type": "application/json" };

  // A far-future week no seeded booking touches; a random offset lets the bench be re-run on one database.
  const start = new Date(Date.UTC(2040, 0, 2) + Math.floor(Math.random() * 400) * 7 * 86_400_000);
  const from = start.toISOString().slice(0, 10);
  const to = new Date(start.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  const av = (await (
    await fetch(
      `${base}/branches/${branch}/availability?serviceId=${service}&from=${from}&to=${to}`,
      { headers: h },
    )
  ).json()) as { slots: { startAt: string; staffId: string }[] };
  // Pick slots that do not overlap each other for the same staff (one slot per staff per 2h).
  const picked: { startAt: string; staffId: string }[] = [];
  const lastEnd = new Map<string, number>();
  for (const s of av.slots) {
    const t = Date.parse(s.startAt);
    if (t < (lastEnd.get(s.staffId) ?? 0)) continue;
    picked.push(s);
    lastEnd.set(s.staffId, t + 2 * 3_600_000);
    if (picked.length >= SLOTS) break;
  }
  if (picked.length === 0) throw new Error("no slots to benchmark");

  const times: number[] = [];
  const codes = new Map<number, number>();
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < REQUESTS) {
        const i = next++;
        const s = picked[i % picked.length]!;
        const a = performance.now();
        const res = await fetch(`${base}/bookings`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({
            branchId: branch,
            serviceId: service,
            customerId: customer,
            startAt: s.startAt,
            staffId: s.staffId,
          }),
        });
        await res.arrayBuffer();
        times.push(performance.now() - a);
        codes.set(res.status, (codes.get(res.status) ?? 0) + 1);
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;

  const [row] = await admin.$queryRaw<{ confirmed: bigint; overlap_rows: bigint }[]>`
    select (select count(*) from bookings where tenant_id = ${tenant}::uuid and status = 'confirmed' and start_at >= ${start} and start_at < ${new Date(start.getTime() + 7 * 86_400_000)}) confirmed,
           (select count(*) from booking_resources a join booking_resources b
              on a.resource_id = b.resource_id and a.booking_id < b.booking_id and a.time_range && b.time_range
            where a.tenant_id = ${tenant}::uuid and a.status = 'confirmed' and b.status = 'confirmed') overlap_rows`;
  const { confirmed, overlap_rows } = row!;
  await app.close();
  await admin.$disconnect();

  console.log(
    `\nMachine: ${os.cpus()[0]?.model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM, Node ${process.version}, ${version.split(",")[0]}`,
  );
  console.log(
    `Load: ${REQUESTS} POST /bookings over ${picked.length} contended slots, ${CONCURRENCY} concurrent clients`,
  );
  console.log(
    `Status codes: ${[...codes]
      .sort()
      .map(([c, n]) => `${c}×${n}`)
      .join(", ")}`,
  );
  console.log(
    `Confirmed bookings created: ${confirmed} (expected ${picked.length}); overlapping rows: ${overlap_rows}`,
  );
  console.log(
    `Throughput: ${(REQUESTS / seconds).toFixed(0)} req/s; latency ms p50 ${pct(times, 50).toFixed(1)}, p95 ${pct(times, 95).toFixed(1)}, p99 ${pct(times, 99).toFixed(1)}`,
  );
  if (Number(confirmed) !== picked.length || Number(overlap_rows) !== 0)
    throw new Error("INVARIANT VIOLATED");
}
void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
