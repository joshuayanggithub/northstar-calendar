// The "Other calendars" work like an inbox: you copy an event from one into
// a calendar of yours (App's copyTo), and from then on your copy stands for
// it — the original steps aside instead of sitting beside (or around) its
// own copy. Which original a copy came from is remembered per device, like
// stars; an event of yours with the same title and times counts as a copy
// too (made by hand, on another device, or the other occurrences of a
// copied series). Delete the copy and the original is back.

import type { CalendarEvent } from "./types";

const KEY = "event-copies";
type Ref = { calendar_id: string; id: string };
let cache: Record<string, Ref> | null = null;

const keyOf = (e: { calendar_id: string; id: string }) => `${e.calendar_id}/${e.id}`;

function load(): Record<string, Ref> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    cache = {};
  }
  return cache!;
}

export function linkCopy(original: { calendar_id: string; id: string }, copy: Ref) {
  const m = load();
  m[keyOf(original)] = copy;
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode: remembered for the session */
  }
}

/** keys (`calendar/id`) of the read-only events that have a copy of yours
 *  among `events` */
export function copiedKeys(events: CalendarEvent[], readOnly: (e: CalendarEvent) => boolean): Set<string> {
  const links = load();
  const t = (x: string) => new Date(x).getTime();
  const sig = (e: CalendarEvent) => `${t(e.start)}|${t(e.end)}|${e.summary.trim()}`;
  const yours = new Set<string>();
  const shapes = new Set<string>();
  for (const e of events) {
    if (readOnly(e)) continue;
    yours.add(keyOf(e));
    if (e.recurring_event_id) yours.add(`${e.calendar_id}/${e.recurring_event_id}`);
    shapes.add(sig(e));
  }
  const out = new Set<string>();
  if (!yours.size) return out;
  for (const e of events) {
    if (!readOnly(e)) continue;
    const ref = links[keyOf(e)];
    if ((ref && yours.has(keyOf(ref))) || shapes.has(sig(e))) out.add(keyOf(e));
  }
  return out;
}
