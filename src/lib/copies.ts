// The "Other calendars" work like an inbox: you copy an event from one into
// a calendar of yours (App's copyTo), and from then on your copy stands for
// it — the original steps aside instead of sitting beside (or around) its
// own copy. Which original a copy came from is remembered per device, like
// stars; an event of yours with the same title and times counts as a copy
// too (made by hand, on another device, or the other occurrences of a
// copied series). Delete the copy and the original is back.

import type { CalendarEvent } from "./types";

const KEY = "event-copies";
/** the copy, and the original's times + title when it was copied */
type Ref = { calendar_id: string; id: string; sig?: string };
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

const t = (x: string) => new Date(x).getTime();
const sigOf = (e: CalendarEvent) => `${t(e.start)}|${t(e.end)}|${e.summary.trim()}`;

function persist(m: Record<string, Ref>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode: remembered for the session */
  }
}

export function linkCopy(original: CalendarEvent, copy: { calendar_id: string; id: string }) {
  const m = load();
  m[keyOf(original)] = { ...copy, sig: sigOf(original) };
  persist(m);
}

/** a copy re-created under a new id (an undone delete) keeps its link, so
 *  its original stays stepped aside */
export function carryCopy(fromId: string, toId: string) {
  const m = load();
  let changed = false;
  for (const k of Object.keys(m)) {
    if (m[k].id !== fromId) continue;
    m[k] = { ...m[k], id: toId };
    changed = true;
  }
  if (changed) persist(m);
}

/** keys (`calendar/id`) of the read-only events that have a copy of yours
 *  among `events` */
export function copiedKeys(events: CalendarEvent[], readOnly: (e: CalendarEvent) => boolean): Set<string> {
  const links = load();
  const sig = sigOf;
  const yours = new Set<string>();
  // (by id too: a copy moved to another of your calendars keeps its id)
  const yourIds = new Set<string>();
  const shapes = new Set<string>();
  for (const e of events) {
    if (readOnly(e)) continue;
    yours.add(keyOf(e));
    yourIds.add(e.id);
    if (e.recurring_event_id) yours.add(`${e.calendar_id}/${e.recurring_event_id}`);
    shapes.add(sig(e));
  }
  const out = new Set<string>();
  if (!yours.size) return out;
  let upgraded = false;
  for (const e of events) {
    if (!readOnly(e)) continue;
    const ref = links[keyOf(e)];
    // a link made before links kept the original's shape: take it as is now
    if (ref && !ref.sig) {
      ref.sig = sig(e);
      upgraded = true;
    }
    // The link stands only while the original is as it was copied: moved or
    // renamed by its owner (the school moved the lecture) it comes back
    // beside your copy instead of hiding behind a stale one.
    const linked = !!ref && (yours.has(keyOf(ref)) || yourIds.has(ref.id)) && ref.sig === sig(e);
    if (linked || shapes.has(sig(e))) out.add(keyOf(e));
  }
  if (upgraded) persist(links);
  return out;
}
