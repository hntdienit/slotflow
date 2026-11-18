import { SendEmailCommand, type SESClient } from "@aws-sdk/client-ses";
import type { Pool } from "pg";

export interface Outgoing {
  notificationId: string;
  tenantId: string;
  to: string;
  subject: string;
  body: string;
}

/** A delivery channel. `send` must throw on failure so the caller can retry with backoff. */
export interface NotificationChannel {
  readonly name: "email" | "sms";
  send(msg: Outgoing): Promise<void>;
}

/** Email through Amazon SES (LocalStack in dev; inspect sent mail at GET /_aws/ses). */
export class SesEmailChannel implements NotificationChannel {
  readonly name = "email" as const;
  constructor(
    private readonly ses: SESClient,
    private readonly from: string,
  ) {}
  async send(m: Outgoing) {
    await this.ses.send(
      new SendEmailCommand({
        Source: this.from,
        Destination: { ToAddresses: [m.to] },
        Message: {
          Subject: { Data: m.subject, Charset: "UTF-8" },
          Body: { Text: { Data: m.body, Charset: "UTF-8" } },
        },
      }),
    );
  }
}

/** Mock SMS: "sending" records the message in `sms_messages` (one row per notification). */
export class SmsMockChannel implements NotificationChannel {
  readonly name = "sms" as const;
  constructor(private readonly pool: Pool) {}
  async send(m: Outgoing) {
    await this.pool.query(
      `INSERT INTO sms_messages (tenant_id, notification_id, to_phone, body)
       VALUES ($1, $2, $3, $4) ON CONFLICT (notification_id) DO NOTHING`,
      [m.tenantId, m.notificationId, m.to, `${m.subject}: ${m.body}`],
    );
  }
}
