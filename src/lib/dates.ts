// Date helpers. "now" is injectable via ?now= for deterministic e2e snapshots.

import {
  addDays,
  addMonths,
  addWeeks,
  format,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  endOfMonth,
  endOfWeek,
} from "date-fns";

export { addDays, addMonths, addWeeks, format, isSameDay, isSameMonth, startOfDay };

/** the locale every label is written in: the UI is English, 12-hour, so
 *  the few labels that followed the system locale read "14:30" beside
 *  chips saying "2:30 PM" (and "Okt 1" under "October 2026") in de-DE */
export const LOCALE = "en-US";

let fixedNow: Date | null = null;
{
  const p = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("now");
  if (p) {
    // (a bare date is local midnight: as UTC it was the evening before here)
    const ymd = p.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(p);
    if (!isNaN(d.getTime())) fixedNow = d;
  }
}

export function now(): Date {
  return fixedNow ? new Date(fixedNow) : new Date();
}

export const WEEK_STARTS_ON = 0 as const; // Sunday, like the references

export function weekStart(d: Date): Date {
  return startOfWeek(d, { weekStartsOn: WEEK_STARTS_ON });
}

export function weekDays(d: Date): Date[] {
  const s = weekStart(d);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

/** Weeks covering d's month, each an array of 7 days. */
export function monthGrid(d: Date): Date[][] {
  const first = weekStart(startOfMonth(d));
  const last = endOfWeek(endOfMonth(d), { weekStartsOn: WEEK_STARTS_ON });
  const weeks: Date[][] = [];
  for (let cur = first; cur <= last; cur = addDays(cur, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cur, i)));
  }
  return weeks;
}

/** a move measured on the wall clock: whole calendar days, then minutes */
/** business: `days` counts weekdays (a move made with weekends hidden) */
export type WallShift = { days: number; minutes: number; business?: boolean };

/** the shift that takes `from` to `to`, on the wall clock */
export function wallShiftBetween(from: Date, to: Date): WallShift {
  const days = Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);
  return { days, minutes: minutesOfDay(to) - minutesOfDay(from) };
}

/** `d` moved by a wall-clock shift: 9:00 stays 9:00 on the new day, even
 *  across a daylight-saving change (a fixed number of ms would land an hour
 *  off); minutes past midnight roll into the next day */
export function shiftWallClock(d: Date, s: WallShift): Date {
  const x = startOfDay(d);
  if (s.business) {
    // with weekends hidden a column is a weekday: Fri + 1 is Mon, not Sat
    const dir = s.days < 0 ? -1 : 1;
    for (let moved = 0; moved < Math.abs(s.days);) {
      x.setDate(x.getDate() + dir);
      if (x.getDay() !== 0 && x.getDay() !== 6) moved++;
    }
  } else x.setDate(x.getDate() + s.days);
  x.setHours(0, minutesOfDay(d) + s.minutes, d.getSeconds(), d.getMilliseconds());
  return x;
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function fmtTimeShort(d: Date): string {
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  const ap = d.getHours() < 12 ? "AM" : "PM";
  return m === 0 ? `${h} ${ap}` : `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

export function fmtChipTime(d: Date): string {
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes();
  return m === 0 ? `${h}` : `${h}:${String(m).padStart(2, "0")}`;
}

export function fmtChipRange(start: Date, end: Date): string {
  const ap = (d: Date) => (d.getHours() < 12 ? "AM" : "PM");
  const sameAp = ap(start) === ap(end);
  return `${fmtChipTime(start)}${sameAp ? "" : " " + ap(start)} – ${fmtChipTime(end)} ${ap(end)}`;
}

/** Event start/end strings -> local Dates. All-day uses date-only strings. */
const parsedEventDates = new WeakMap<object, {
  rawStart: string;
  rawEnd: string;
  allDay: boolean;
  startMs: number;
  endMs: number;
}>();

export function eventDates(e: { start: string; end: string; all_day: boolean }): {
  start: Date;
  end: Date;
} {
  let parsed = parsedEventDates.get(e);
  if (!parsed || parsed.rawStart !== e.start || parsed.rawEnd !== e.end || parsed.allDay !== e.all_day) {
    // YYYY-MM-DD parses as UTC; append local midnight for all-day events.
    const startMs = new Date(e.all_day ? e.start + "T00:00:00" : e.start).getTime();
    const endMs = new Date(e.all_day ? e.end + "T00:00:00" : e.end).getTime();
    parsed = { rawStart: e.start, rawEnd: e.end, allDay: e.all_day, startMs, endMs };
    parsedEventDates.set(e, parsed);
  }
  return { start: new Date(parsed.startMs), end: new Date(parsed.endMs) };
}

export function toLocalISO(d: Date): string {
  // RFC3339 with local offset, which Google accepts and keeps readable.
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return (
    format(d, "yyyy-MM-dd'T'HH:mm:ss") + `${sign}${pad(Math.trunc(tz / 60))}:${pad(tz % 60)}`
  );
}

export function toDateOnly(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/** The wall clock of an instant in an IANA zone: its date and time there. */
export function wallIn(d: Date, timeZone: string): { date: string; h: number; m: number; s: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, h: Number(parts.hour) % 24, m: Number(parts.minute), s: Number(parts.second) };
}

/** An instant as RFC 3339 in a zone's wall clock and offset. */
export function isoInZone(d: Date, timeZone: string): string {
  const w = wallIn(d, timeZone);
  const [Y, M, D] = w.date.split("-").map(Number);
  const off = Math.round((Date.UTC(Y, M - 1, D, w.h, w.m, w.s) - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const a = Math.abs(off);
  return `${w.date}T${pad(w.h)}:${pad(w.m)}:${pad(w.s)}${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The instant a wall clock in a zone names (YYYY-MM-DD, h:m:s there), as
 *  RFC 3339 with that zone's offset: a series' times are its zone's, not
 *  this computer's (a Tokyo series edited from New York across a DST
 *  change kept its old time). */
export function zonedISO(date: string, h: number, m: number, s: number, timeZone: string): string {
  const [Y, M, D] = date.split("-").map(Number);
  const want = Date.UTC(Y, M - 1, D, h, m, s);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const w = wallIn(new Date(t), timeZone);
    const [y2, m2, d2] = w.date.split("-").map(Number);
    t += want - Date.UTC(y2, m2 - 1, d2, w.h, w.m, w.s);
  }
  return isoInZone(new Date(t), timeZone);
}
