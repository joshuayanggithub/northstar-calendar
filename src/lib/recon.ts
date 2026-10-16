// Event reconciliation: a past event is UNCONFIRMED until the user says it
// happened ("done"), was canceled ("canceled" — skipped, but kept on the
// calendar as a struck-through record), or didn't happen (the event is
// deleted outright: App's removeOccurrence), or moves it. Local-first
// storage like stars; syncing via Google extendedProperties is the logged
// follow-up.

import { classify, RECON_WINDOW_MS } from "./insights";
import { eventDates } from "./dates";
import type { Calendar, CalendarEvent } from "./types";

export type ReconStatus = "done" | "canceled";

const KEY = "recon";
let cache: Record<string, { s: ReconStatus; at: number }> | null = null;
const listeners = new Set<() => void>();

/** events older than this are grandfathered (count as done) so adopting the
 *  feature doesn't zero every historical score */
export { RECON_WINDOW_MS };
const SINCE_KEY = "recon-since";

function load(): Record<string, { s: ReconStatus; at: number }> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    cache = {};
  }
  // "missed" was the old name of the kept, struck-through state
  for (const v of Object.values(cache!)) if ((v.s as string) === "missed") v.s = "canceled";
  return cache!;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache ?? {}));
  } catch {
    /* session-only in private mode */
  }
  listeners.forEach((l) => l());
}

export const reconKey = (e: { calendar_id: string; id: string }) =>
  `${e.calendar_id}/${e.id}`;

export function reconOf(key: string): ReconStatus | null {
  return load()[key]?.s ?? null;
}

export function setRecon(key: string, s: ReconStatus | null) {
  const m = load();
  if (s === null) delete m[key];
  else m[key] = { s, at: Date.now() };
  if (s !== null) reconSince(); // pin the adoption date on the first review
  save();
}

/** When the user started reconciling (ms), or null if never. The focus
 *  score treats deep work that ended before (this − the review window) as
 *  history; after it, deep work must be confirmed to count in full. */
export function reconSince(): number | null {
  try {
    const v = Number(localStorage.getItem(SINCE_KEY));
    if (v > 0) return v;
  } catch {
    /* fall through */
  }
  const ats = Object.values(load())
    .map((v) => v.at)
    .filter((t) => t > 0);
  if (!ats.length) return null;
  const first = Math.min(...ats);
  try {
    localStorage.setItem(SINCE_KEY, String(first));
  } catch {
    /* session-only */
  }
  return first;
}

export function subscribeRecon(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** sleep and all-day events reconcile themselves; nothing to check off */
export function reconExempt(e: CalendarEvent, calendars: Calendar[]): boolean {
  return e.all_day || classify(e, calendars) === "sleep";
}

export type ReconState = ReconStatus | "unsettled" | null;

/** null = not yet ended (or exempt); "unsettled" = ended, awaiting the user */
export function reconState(
  e: CalendarEvent,
  calendars: Calendar[],
  now: Date,
): ReconState {
  const { end } = eventDates(e);
  if (end.getTime() > now.getTime() || reconExempt(e, calendars)) return null;
  const explicit = reconOf(reconKey(e));
  if (explicit) return explicit;
  if (now.getTime() - end.getTime() > RECON_WINDOW_MS) return "done"; // grandfathered
  return "unsettled";
}

/** oldest-first queue of events awaiting reconciliation */
export function unreconciled(
  events: CalendarEvent[],
  calendars: Calendar[],
  now: Date,
  opts?: { from?: Date; to?: Date },
): CalendarEvent[] {
  return events
    .filter((e) => {
      if (reconState(e, calendars, now) !== "unsettled") return false;
      const { start } = eventDates(e);
      if (opts?.from && start < opts.from) return false;
      if (opts?.to && start >= opts.to) return false;
      return true;
    })
    .sort((a, b) => eventDates(a).start.getTime() - eventDates(b).start.getTime());
}
