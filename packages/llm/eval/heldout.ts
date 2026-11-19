import { B, S, type Case } from "./dataset";

/**
 * Written AFTER the rules were tuned on `dataset.ts` and never used to change them, so this is the
 * honest number: the main set is a regression suite for the mock, this one estimates generalisation.
 *
 * First run: 13/16 all-fields-correct (81.3%). One failure was a wrong label of mine (next Tuesday is
 * 24 Nov, not 1 Dec); three were real parser gaps ("tuần này", "this evening", "before noon"), fixed
 * afterwards. So this set is now partly tuned too; write fresh cases before quoting a generalisation figure.
 */
const book = (
  language: "vi" | "en",
  rest: Case["expect"] extends infer E ? Partial<E> : never = {},
): Case["expect"] => ({ language, intent: "book", ...rest }) as Case["expect"];

export const HELD_OUT: Case[] = [
  {
    text: "Mình muốn đi khám nhi vào sáng chủ nhật tuần này ở Quận 1",
    expect: book("vi", {
      serviceId: S.pediatric,
      branchId: B.q1,
      date: "2026-11-22",
      timeAfter: "06:00",
      timeBefore: "12:00",
    }),
  },
  {
    text: "Cho tôi đặt xét nghiệm máu ngày 30/11 sau 8 giờ sáng",
    expect: book("vi", {
      serviceId: S.blood,
      date: "2026-11-30",
      timeAfter: "08:00",
      timeBefore: "12:00",
    }),
  },
  {
    text: "Em ơi đặt giúp anh cái siêu âm chiều mai nhé",
    expect: book("vi", {
      serviceId: S.ultrasound,
      date: "2026-11-20",
      timeAfter: "12:00",
      timeBefore: "18:00",
    }),
  },
  {
    text: "Chị muốn cắt tóc thứ tư tuần sau lúc 4 giờ chiều",
    expect: book("vi", { serviceId: S.haircut, date: "2026-11-25", timeAfter: "16:00" }),
  },
  {
    text: "tư vấn dinh dưỡng ngày 2 tháng 12 được không ạ",
    expect: book("vi", { serviceId: S.nutrition, date: "2026-12-02" }),
  },
  {
    text: "Khám tổng quát ở chi nhánh Cầu Giấy hôm nay nhé",
    expect: book("vi", { serviceId: S.general, branchId: B.caugiay, date: "2026-11-19" }),
  },
  {
    text: "Hi, could I book a haircut on Friday after 5pm?",
    expect: book("en", { serviceId: S.haircut, date: "2026-11-20", timeAfter: "17:00" }),
  },
  {
    text: "Looking for a blood test next Tuesday before noon",
    expect: book("en", { serviceId: S.blood, date: "2026-11-24", timeBefore: "12:00" }),
  },
  {
    text: "Please schedule a general checkup on 5 December at 9:30am",
    expect: book("en", { serviceId: S.general, date: "2026-12-05", timeAfter: "09:30" }),
  },
  {
    text: "I need a pediatric appointment tomorrow morning at An Tam Cau Giay",
    expect: book("en", {
      serviceId: S.pediatric,
      branchId: B.caugiay,
      date: "2026-11-20",
      timeAfter: "06:00",
      timeBefore: "12:00",
    }),
  },
  {
    text: "Can you fit me in for an ultrasound this evening?",
    expect: book("en", {
      serviceId: S.ultrasound,
      date: "2026-11-19",
      timeAfter: "18:00",
      timeBefore: "22:00",
    }),
  },
  {
    text: "the second one works",
    awaiting: "choice",
    expect: { language: "en", intent: "choose", choice: 2 },
  },
  {
    text: "Lựa chọn số 3 đi",
    awaiting: "choice",
    expect: { language: "vi", intent: "choose", choice: 3 },
  },
  {
    text: "yes that's right",
    awaiting: "confirmation",
    expect: { language: "en", intent: "confirm" },
  },
  {
    text: "Thôi để hôm khác",
    awaiting: "confirmation",
    expect: { language: "vi", intent: "decline" },
  },
  { text: "What are your prices?", expect: { language: "en", intent: "other" } },
];
