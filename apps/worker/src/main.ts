import pino from "pino";

const log = pino({ name: "slotflow-worker" });

// M0 skeleton. Processors (outbox dispatcher, reminder, waitlist-offer, hold-sweeper) land in M4/M5.
log.info("worker started (no processors registered yet)");
const keepAlive = setInterval(() => undefined, 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(keepAlive);
    log.info({ sig }, "worker stopping");
    process.exit(0);
  });
}
