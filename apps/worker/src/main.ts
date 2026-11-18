import Redis from "ioredis";
import pino from "pino";
import { Pool } from "pg";
import { awsConfig, sesClient, sqsClient } from "./aws";
import { SesEmailChannel, SmsMockChannel } from "./channels";
import { loadConfig } from "./config";
import { consumeDeadLetters, consumeNotifications, enqueueDue } from "./delivery";
import { ensureInfrastructure } from "./infra";
import { consumeEvents, relayOutbox } from "./outbox";
import { expireWaitlistEntries, sweepExpiredHolds } from "./sweeper";
import { HttpWaitlistClient, configureWaitlist } from "./waitlist";

const log = pino({ name: "slotflow-worker" });
const cfg = loadConfig();
const aws = awsConfig();
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 8 });
const ses = sesClient(aws);
const redis = cfg.redisUrl
  ? new Redis(cfg.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : null;
const channels = [new SesEmailChannel(ses, cfg.mailFrom), new SmsMockChannel(pool)];

if (cfg.apiUrl && cfg.internalKey)
  configureWaitlist(new HttpWaitlistClient(cfg.apiUrl, cfg.internalKey));
else
  log.warn("API_URL / INTERNAL_API_KEY not set: freed slots will not be offered to the waitlist");

let stopping = false;
const timers: NodeJS.Timeout[] = [];
/** Runs `fn` repeatedly, never overlapping itself, surviving errors. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  const tick = async () => {
    if (stopping) return;
    try {
      const out = await fn();
      if (out && typeof out === "object" && Object.values(out).some((v) => v))
        log.debug({ job: name, out }, "tick");
      else if (typeof out === "number" && out > 0) log.debug({ job: name, out }, "tick");
    } catch (err) {
      log.error({ job: name, err: (err as Error).message }, "job failed");
    }
    if (!stopping) timers.push(setTimeout(tick, ms));
  };
  void tick();
}

async function main() {
  // Retry until the AWS endpoint (LocalStack) is up, so start order does not matter.
  let q;
  for (let i = 1; ; i++) {
    try {
      q = await ensureInfrastructure(sqsClient(aws), ses, {
        prefix: cfg.queuePrefix,
        maxReceiveCount: cfg.maxAttempts,
        sender: cfg.mailFrom,
      });
      break;
    } catch (err) {
      log.warn({ attempt: i, err: (err as Error).message }, "waiting for AWS endpoint");
      if (i >= 30) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const opts = { backoffBaseMs: cfg.backoffBaseMs };
  every("outbox-relay", 1000, () => relayOutbox(pool, q.events));
  every("events", 200, () => consumeEvents(pool, q.events, opts));
  every("enqueue-due", 5000, () => enqueueDue(pool, q.notifications));
  every("notifications", 200, () => consumeNotifications(pool, q.notifications, channels, opts));
  every("notification-dlq", 10_000, () => consumeDeadLetters(pool, q.notificationsDlq));
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
  every("waitlist-expiry", 60_000, () => expireWaitlistEntries(pool));
  log.info("worker started: outbox relay, SQS consumers, hold sweeper");
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, "worker failed to start");
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    timers.forEach(clearTimeout);
    log.info({ sig }, "worker stopping");
    void Promise.allSettled([pool.end(), redis?.quit()]).then(() => process.exit(0));
  });
}
