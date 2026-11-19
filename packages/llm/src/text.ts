/** Lower case, strip diacritics (including đ) and punctuation so "Chiều mai" matches "chieu mai". */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9:/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const VI_WORDS =
  /\b(toi|minh|cho|dat lich|hen|ngay|chieu|sang|chi nhanh|gio|khong|dong y|xac nhan|nhe|giup|muon|kham|rang)\b/;

export function detectLanguage(raw: string): "vi" | "en" {
  return VI_CHARS.test(raw) || VI_WORDS.test(normalize(raw)) ? "vi" : "en";
}

export interface LocalNow {
  ymd: string;
  /** 0 = Monday ... 6 = Sunday */
  weekday: number;
}

export function localNow(iso: string, timeZone: string): LocalNow {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
  return { ymd: parts, weekday: idx };
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (h: number, m = 0) => `${pad(h)}:${pad(m)}`;
