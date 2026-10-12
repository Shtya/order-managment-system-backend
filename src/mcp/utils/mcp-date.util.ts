import { z } from "zod";

/**
 * Business calendar helpers for MCP tools.
 *
 * Every date-only filter (`YYYY-MM-DD`) a tool accepts is a calendar day in
 * the business timezone (Africa/Cairo), and `endDate` is inclusive. Use
 * `businessDayRange` to turn the two strings into exact UTC instants before
 * handing them to a service, so the result never depends on the server's or
 * the database session's timezone.
 */
export const BUSINESS_TZ = "Africa/Cairo";

const DAY_MS = 86_400_000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Permissive 8-4-4-4-12 hex: accepts every id Postgres `uuid` accepts in canonical form.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30, 2026-13-45). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = YMD_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Zod field for a uuid id. `extra` lists allowed literal keywords (e.g. ["all"]). */
export function uuidField(description: string, extra: readonly string[] = []) {
  const hint = extra.length ? ` or one of: ${extra.map((e) => `"${e}"`).join(", ")}` : "";
  return z
    .string()
    .refine((v) => isUuid(v) || extra.includes(v), {
      message: `Must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)${hint}. Look the id up instead of guessing it.`,
    })
    .describe(description);
}

/** Zod field for a calendar date `YYYY-MM-DD` that must exist. */
export function isoDateField(description: string) {
  return z
    .string()
    .refine(isIsoDate, {
      message: "Must be a real calendar date in YYYY-MM-DD format (e.g. 2026-05-31).",
    })
    .describe(description);
}

const ymdToUtc = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

export const utcToYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Adds whole days to a YYYY-MM-DD string. */
export const addDays = (ymd: string, days: number) => utcToYmd(ymdToUtc(ymd) + days * DAY_MS);

/** Number of calendar days from `a` to `b` (b - a). */
export const daysBetween = (a: string, b: string) => Math.round((ymdToUtc(b) - ymdToUtc(a)) / DAY_MS);

/** Offset (ms) of `tz` from UTC at instant `ms`. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** First instant of calendar day `ymd` in `tz` (handles DST days that start at 01:00). */
export function startOfBusinessDay(ymd: string, tz = BUSINESS_TZ): Date {
  const wall = ymdToUtc(ymd);
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  // If local midnight does not exist (DST jump), the guess lands on the previous day; step forward.
  if (businessYmd(guess, tz) !== ymd) guess += 3_600_000;
  return new Date(guess);
}

/** Calendar date (YYYY-MM-DD) of instant `ms` in `tz`. */
export function businessYmd(ms: number = Date.now(), tz = BUSINESS_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(ms),
  );
}

/**
 * Turns inclusive business-calendar days into exact instants:
 * start = first instant of `startDate`, end = last millisecond of `endDate`.
 */
export function businessDayRange(startDate?: string, endDate?: string): { start?: Date; end?: Date } {
  return {
    start: startDate ? startOfBusinessDay(startDate) : undefined,
    end: endDate ? new Date(startOfBusinessDay(addDays(endDate, 1)).getTime() - 1) : undefined,
  };
}

/** Inclusive first/last instants of a calendar month in the business timezone. */
export function businessMonthRange(year: number, month: number): { start: Date; end: Date } {
  const startYmd = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endYmd = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  const { start, end } = businessDayRange(startYmd, endYmd);
  return { start: start!, end: end! };
}

export const TREND_RANGES = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_year",
] as const;
export type TrendRange = (typeof TREND_RANGES)[number];

/** Resolves a quick range to inclusive business-calendar days. Weeks start on Sunday. */
export function resolveQuickRange(range: TrendRange, today = businessYmd()): { startDate: string; endDate: string } {
  const [y, m] = today.split("-").map(Number);
  const dow = new Date(ymdToUtc(today)).getUTCDay(); // 0 = Sunday
  const weekStart = addDays(today, -dow);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  switch (range) {
    case "today":
      return { startDate: today, endDate: today };
    case "yesterday":
      return { startDate: addDays(today, -1), endDate: addDays(today, -1) };
    case "last_7_days":
      return { startDate: addDays(today, -6), endDate: today };
    case "last_30_days":
      return { startDate: addDays(today, -29), endDate: today };
    case "this_week":
      return { startDate: weekStart, endDate: today };
    case "last_week":
      return { startDate: addDays(weekStart, -7), endDate: addDays(weekStart, -1) };
    case "this_month":
      return { startDate: monthStart, endDate: today };
    case "last_month": {
      const prevEnd = addDays(monthStart, -1);
      return { startDate: `${prevEnd.slice(0, 7)}-01`, endDate: prevEnd };
    }
    case "this_year":
      return { startDate: `${y}-01-01`, endDate: today };
  }
}

/**
 * Splits inclusive days [startDate, endDate] into exactly `min(points, days)`
 * consecutive buckets whose lengths differ by at most one day (longer buckets first).
 * Each bucket is inclusive on both ends, in calendar days.
 */
export function splitDays(startDate: string, endDate: string, points: number): { startDate: string; endDate: string }[] {
  const days = daysBetween(startDate, endDate) + 1;
  if (days <= 0) return [];
  const n = Math.max(1, Math.min(points, days));
  const base = Math.floor(days / n);
  const longer = days % n;
  const out: { startDate: string; endDate: string }[] = [];
  let cursor = startDate;
  for (let i = 0; i < n; i++) {
    const len = base + (i < longer ? 1 : 0);
    out.push({ startDate: cursor, endDate: addDays(cursor, len - 1) });
    cursor = addDays(cursor, len);
  }
  return out;
}
