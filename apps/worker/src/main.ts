import Redis from "ioredis";
import pino from "pino";
import { Pool } from "pg";
import { EmailChannel, SmsMockChannel } from "./channels";
import { loadConfig } from "./config";
import { deliverDue } from "./delivery";
import { dispatchOutbox } from "./outbox";
import { sweepExpiredHolds } from "./sweeper";

const log = pino({ name: "slotflow-worker" });
const cfg = loadConfig();
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 5 });
const redis = cfg.redisUrl
  ? new Redis(cfg.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : null;
const channels = [
  new EmailChannel(cfg.smtpHost, cfg.smtpPort, cfg.mailFrom),
  new SmsMockChannel(pool),
];

let stopping = false;
/** Runs `fn` every `ms`, never overlapping itself, surviving errors. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  const tick = async () => {
    if (stopping) return;
    try {
      const out = await fn();
      if (out && JSON.stringify(out) !== "{}") log.debug({ job: name, out }, "tick");
    } catch (err) {
      log.error({ job: name, err: (err as Error).message }, "job failed");
    }
    if (!stopping) timers.push(setTimeout(tick, ms));
  };
  void tick();
}
const timers: NodeJS.Timeout[] = [];

every("outbox", 1000, () =>
  dispatchOutbox(pool, { maxAttempts: cfg.maxAttempts, backoffBaseMs: cfg.backoffBaseMs }),
);
every("delivery", 2000, () =>
  deliverDue(pool, channels, { maxAttempts: cfg.maxAttempts, backoffBaseMs: cfg.backoffBaseMs }),
);
every("hold-sweeper", 15_000, async () => {
  const branches = await sweepExpiredHolds(pool);
  // Availability cache versions (same keys as the API's CacheService); a cache outage must not fail the job.
  if (redis && branches.length) {
    try {
      if (redis.status === "wait") await redis.connect();
      await Promise.all(branches.map((b) => redis.incr(`ver:br:${b.tenantId}:${b.branchId}`)));
    } catch (err) {
      log.warn({ err: (err as Error).message }, "cache bump failed");
    }
  }
  return { expired: branches.length };
});
log.info("worker started: outbox dispatcher, notification delivery, hold sweeper");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    timers.forEach(clearTimeout);
    log.info({ sig }, "worker stopping");
    void Promise.allSettled([pool.end(), redis?.quit()]).then(() => process.exit(0));
  });
}
