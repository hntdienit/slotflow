import type { MessageContext } from "./delivery";

/** Vietnamese for branches in Vietnam, English otherwise. */
export function renderMessage(
  type: string,
  c: MessageContext,
  extra: { offerId?: string; expiresAt?: string } = {},
): { subject: string; body: string } {
  const vi = c.timezone === "Asia/Ho_Chi_Minh";
  const when = new Intl.DateTimeFormat(vi ? "vi-VN" : "en-AU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: c.timezone,
  }).format(c.start_at);
  const until = extra.expiresAt
    ? new Intl.DateTimeFormat(vi ? "vi-VN" : "en-AU", {
        timeStyle: "short",
        timeZone: c.timezone,
      }).format(new Date(extra.expiresAt))
    : "";
  const what = `${c.service_name} @ ${c.branch_name}, ${when}`;
  const t: Record<string, [string, string]> = vi
    ? {
        confirmation: ["Xác nhận lịch hẹn", `Lịch hẹn của bạn đã được xác nhận: ${what}.`],
        reminder_24h: ["Nhắc lịch hẹn ngày mai", `Bạn có lịch hẹn vào ngày mai: ${what}.`],
        reminder_2h: ["Nhắc lịch hẹn sau 2 giờ", `Lịch hẹn của bạn sắp diễn ra: ${what}.`],
        booking_rescheduled: ["Lịch hẹn đã được đổi", `Lịch hẹn của bạn được đổi sang: ${what}.`],
        booking_cancelled: ["Lịch hẹn đã được hủy", `Lịch hẹn ${what} đã được hủy.`],
        waitlist_offer: [
          "Có chỗ trống cho bạn",
          `Một khung giờ bạn đang chờ đã trống: ${what}. Chúng tôi giữ chỗ cho bạn đến ${until}, hãy xác nhận trước thời điểm đó. Mã lời mời: ${extra.offerId}.`,
        ],
      }
    : {
        confirmation: ["Appointment confirmed", `Your appointment is confirmed: ${what}.`],
        reminder_24h: ["Appointment tomorrow", `Reminder, your appointment is tomorrow: ${what}.`],
        reminder_2h: ["Appointment in 2 hours", `Your appointment is coming up: ${what}.`],
        booking_rescheduled: ["Appointment rescheduled", `Your appointment has moved to: ${what}.`],
        booking_cancelled: ["Appointment cancelled", `Your appointment ${what} was cancelled.`],
        waitlist_offer: [
          "A slot opened up for you",
          `A time you were waiting for is free: ${what}. We are holding it for you until ${until}; please confirm before then. Offer ID: ${extra.offerId}.`,
        ],
      };
  const [subject, body] = t[type] ?? ["SlotFlow", what];
  return { subject, body: `${vi ? "Xin chào" : "Hello"} ${c.customer_name},\n\n${body}` };
}
