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

let fixedNow: Date | null = null;
{
  const p = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("now");
  if (p) {
    const d = new Date(p);
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
export type WallShift = { days: number; minutes: number };

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
  x.setDate(x.getDate() + s.days);
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
