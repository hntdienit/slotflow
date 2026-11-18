import type { MessageContext } from "./delivery";

/** Vietnamese for branches in Vietnam, English otherwise. */
export function renderMessage(type: string, c: MessageContext): { subject: string; body: string } {
  const vi = c.timezone === "Asia/Ho_Chi_Minh";
  const when = new Intl.DateTimeFormat(vi ? "vi-VN" : "en-AU", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: c.timezone,
  }).format(c.start_at);
  const what = `${c.service_name} @ ${c.branch_name}, ${when}`;
  const t: Record<string, [string, string]> = vi
    ? {
        confirmation: ["Xác nhận lịch hẹn", `Lịch hẹn của bạn đã được xác nhận: ${what}.`],
        reminder_24h: ["Nhắc lịch hẹn ngày mai", `Bạn có lịch hẹn vào ngày mai: ${what}.`],
        reminder_2h: ["Nhắc lịch hẹn sau 2 giờ", `Lịch hẹn của bạn sắp diễn ra: ${what}.`],
        booking_rescheduled: ["Lịch hẹn đã được đổi", `Lịch hẹn của bạn được đổi sang: ${what}.`],
        booking_cancelled: ["Lịch hẹn đã được hủy", `Lịch hẹn ${what} đã được hủy.`],
      }
    : {
        confirmation: ["Appointment confirmed", `Your appointment is confirmed: ${what}.`],
        reminder_24h: ["Appointment tomorrow", `Reminder, your appointment is tomorrow: ${what}.`],
        reminder_2h: ["Appointment in 2 hours", `Your appointment is coming up: ${what}.`],
        booking_rescheduled: ["Appointment rescheduled", `Your appointment has moved to: ${what}.`],
        booking_cancelled: ["Appointment cancelled", `Your appointment ${what} was cancelled.`],
      };
  const [subject, body] = t[type] ?? ["SlotFlow", what];
  return { subject, body: `${vi ? "Xin chào" : "Hello"} ${c.customer_name},\n\n${body}` };
}
