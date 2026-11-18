import nodemailer from "nodemailer";
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

export class EmailChannel implements NotificationChannel {
  readonly name = "email" as const;
  private readonly transport;
  constructor(
    host: string,
    port: number,
    private readonly from: string,
  ) {
    // MailHog in dev: plain SMTP, no auth.
    this.transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true });
  }
  async send(m: Outgoing) {
    await this.transport.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.body,
      // Stable id: a re-send after a crash carries the same Message-ID so mail clients can collapse it.
      messageId: `<${m.notificationId}@slotflow.local>`,
    });
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
