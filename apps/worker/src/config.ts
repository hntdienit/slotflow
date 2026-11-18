export interface Config {
  databaseUrl: string;
  redisUrl?: string;
  smtpHost: string;
  smtpPort: number;
  mailFrom: string;
  maxAttempts: number;
  backoffBaseMs: number;
}

export function loadConfig(env = process.env): Config {
  const databaseUrl = env.WORKER_DATABASE_URL;
  // No fallback to DATABASE_URL: that role is bound by tenant RLS and the worker would silently see nothing.
  if (!databaseUrl) throw new Error("WORKER_DATABASE_URL is required (role slotflow_worker)");
  return {
    databaseUrl,
    redisUrl: env.REDIS_URL,
    smtpHost: env.SMTP_HOST ?? "localhost",
    smtpPort: Number(env.SMTP_PORT ?? 1025),
    mailFrom: env.MAIL_FROM ?? "SlotFlow <no-reply@slotflow.local>",
    maxAttempts: Number(env.NOTIFY_MAX_ATTEMPTS ?? 5),
    backoffBaseMs: Number(env.NOTIFY_BACKOFF_BASE_MS ?? 5000),
  };
}
