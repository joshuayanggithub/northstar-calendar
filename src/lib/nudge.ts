// Answering the hourly nudge ("what are you actually doing?", sent by the
// native side, src-tauri/src/notify.rs): the app opens on now, on the event
// you're in, so you can bring it up to date; with none, on a new event for
// this hour.

import { classify } from "./insights";
import { eventDates } from "./dates";
import { readOnlyEvent, type Calendar, type CalendarEvent } from "./types";

/** the event of yours in progress at `now` that the nudge is about: timed,
 *  on one of your calendars, not sleep; of several, the one that started
 *  last (the most specific) */
export function currentEvent(events: CalendarEvent[], calendars: Calendar[], now: Date): CalendarEvent | null {
  const t = now.getTime();
  const live = events.filter((e) => {
    if (e.all_day || e.status === "cancelled" || readOnlyEvent(e, calendars)) return false;
    if (classify(e, calendars) === "sleep") return false;
    const { start, end } = eventDates(e);
    return start.getTime() <= t && end.getTime() > t;
  });
  live.sort((a, b) => eventDates(b).start.getTime() - eventDates(a).start.getTime());
  return live[0] ?? null;
}

/** the hour a new event for "now" covers */
export function thisHour(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  return { start, end: new Date(start.getTime() + 3600_000) };
}
