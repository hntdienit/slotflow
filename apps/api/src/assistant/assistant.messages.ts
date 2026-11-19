/** Fixed reply templates. The model never writes text the customer sees: it only extracts parameters. */
export type Lang = "vi" | "en";

export interface OptionView {
  index: number;
  startAt: string;
  startLocal: string;
}

const fmt = (iso: string, tz: string, lang: Lang) =>
  new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "en-AU", {
    weekday: "long",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(new Date(iso));

export const T = {
  help: (l: Lang) =>
    l === "vi"
      ? 'Mình có thể giúp bạn đặt lịch hẹn. Hãy cho mình biết dịch vụ, chi nhánh và thời gian bạn muốn, ví dụ: "đặt cắt tóc chiều mai sau 3 giờ ở quận 1".'
      : 'I can help you book an appointment. Tell me the service, branch and time you want, for example: "book a haircut tomorrow after 3pm at the city branch".',
  rephrase: (l: Lang) =>
    l === "vi"
      ? "Mình chưa hiểu rõ yêu cầu. Bạn nói lại giúp mình dịch vụ, chi nhánh và thời gian nhé."
      : "I did not quite get that. Could you tell me the service, branch and time again?",
  askService: (l: Lang, names: string[]) =>
    l === "vi"
      ? `Bạn muốn đặt dịch vụ nào? Hiện có: ${names.join(", ")}.`
      : `Which service would you like? We offer: ${names.join(", ")}.`,
  askBranch: (l: Lang, names: string[]) =>
    l === "vi"
      ? `Bạn muốn đặt ở chi nhánh nào? Hiện có: ${names.join(", ")}.`
      : `Which branch would you like? We have: ${names.join(", ")}.`,
  noSlots: (l: Lang) =>
    l === "vi"
      ? "Mình không tìm thấy giờ trống phù hợp. Bạn thử đổi ngày hoặc khung giờ khác nhé."
      : "I could not find a free slot that fits. Could you try another day or time range?",
  options: (l: Lang, service: string, branch: string, tz: string, o: OptionView[]) => {
    const lines = o.map((x) => `${x.index}. ${fmt(x.startAt, tz, l)}`).join("\n");
    return l === "vi"
      ? `Mình tìm được các giờ trống cho ${service} tại ${branch}:\n${lines}\nBạn chọn số mấy?`
      : `Here are the free times for ${service} at ${branch}:\n${lines}\nWhich number would you like?`;
  },
  askChoice: (l: Lang, n: number) =>
    l === "vi" ? `Bạn chọn một số từ 1 đến ${n} nhé.` : `Please pick a number from 1 to ${n}.`,
  confirm: (l: Lang, service: string, branch: string, tz: string, startAt: string) =>
    l === "vi"
      ? `Mình sẽ đặt ${service} tại ${branch} vào ${fmt(startAt, tz, l)}. Bạn xác nhận chứ? (trả lời "có" để đặt, "không" để hủy)`
      : `I will book ${service} at ${branch} on ${fmt(startAt, tz, l)}. Shall I confirm? (reply "yes" to book, "no" to cancel)`,
  askConfirm: (l: Lang) =>
    l === "vi"
      ? 'Bạn trả lời "có" để xác nhận hoặc "không" để hủy nhé.'
      : 'Please reply "yes" to confirm or "no" to cancel.',
  booked: (l: Lang, service: string, branch: string, tz: string, startAt: string) =>
    l === "vi"
      ? `Đã đặt lịch ${service} tại ${branch} vào ${fmt(startAt, tz, l)}. Hẹn gặp bạn!`
      : `Booked: ${service} at ${branch} on ${fmt(startAt, tz, l)}. See you then!`,
  taken: (l: Lang) =>
    l === "vi"
      ? "Rất tiếc, giờ đó vừa có người đặt. Mình tìm giờ khác cho bạn nhé."
      : "Sorry, that time was just taken. Let me look for another one.",
  dismissed: (l: Lang) =>
    l === "vi"
      ? "Mình đã hủy yêu cầu này. Bạn cần gì thêm cứ nói nhé."
      : "No problem, I dropped that request. Tell me if you need anything else.",
  tooMany: (l: Lang) =>
    l === "vi"
      ? "Bạn nhắn quá nhanh, vui lòng thử lại sau ít phút."
      : "You are sending messages too fast. Please try again in a minute.",
};
