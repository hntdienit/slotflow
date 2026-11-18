export interface Config {
  databaseUrl: string;
  redisUrl?: string;
  queuePrefix: string;
  mailFrom: string;
  maxAttempts: number;
  backoffBaseMs: number;
  /** Waitlist matching runs in the API; both must be set for the worker to trigger it. */
  apiUrl?: string;
  internalKey?: string;
}

export function loadConfig(env = process.env): Config {
  const databaseUrl = env.WORKER_DATABASE_URL;
  // No fallback to DATABASE_URL: that role is bound by tenant RLS and the worker would silently see nothing.
  if (!databaseUrl) throw new Error("WORKER_DATABASE_URL is required (role slotflow_worker)");
  return {
    databaseUrl,
    redisUrl: env.REDIS_URL,
    queuePrefix: env.QUEUE_PREFIX ?? "slotflow-",
    mailFrom: env.MAIL_FROM ?? "no-reply@slotflow.local",
    maxAttempts: Number(env.NOTIFY_MAX_ATTEMPTS ?? 5),
    backoffBaseMs: Number(env.NOTIFY_BACKOFF_BASE_MS ?? 5000),
    apiUrl: env.API_URL,
    internalKey: env.INTERNAL_API_KEY,
  };
}
