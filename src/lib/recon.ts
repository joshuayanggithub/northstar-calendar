// Event reconciliation: a past event is UNCONFIRMED until the user says it
// happened ("done"), was canceled ("canceled" — skipped, but kept on the
// calendar as a struck-through record), or didn't happen (the event is
// deleted outright: App's removeOccurrence), or moves it. Local-first
// storage like stars; syncing via Google extendedProperties is the logged
// follow-up.

import { classify, RECON_WINDOW_MS } from "./insights";
import { eventDates, now as clockNow } from "./dates";
import { readOnlyEvent, type Calendar, type CalendarEvent } from "./types";
import { myRsvp } from "./rsvp";
import { liveId, recordUndo } from "./undo";

export type ReconStatus = "done" | "canceled";

const KEY = "recon";
/** for: a cancel's event times ("startMs|endMs") — it holds while they do */
type Mark = { s: ReconStatus; at: number; for?: string };
let cache: Record<string, Mark> | null = null;
const listeners = new Set<() => void>();

/** events older than this are grandfathered (count as done) so adopting the
 *  feature doesn't zero every historical score */
export { RECON_WINDOW_MS };
const SINCE_KEY = "recon-since";

function load(): Record<string, Mark> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    cache = {};
  }
  // (a corrupt value, or one that isn't a map of marks, is no marks: it
  // threw in here and took the whole calendar down with it)
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {};
  for (const [k, v] of Object.entries(cache!)) if (!v || typeof v !== "object") delete cache![k];
  // "missed" was the old name of the kept, struck-through state
  for (const v of Object.values(cache!)) if ((v.s as string) === "missed") v.s = "canceled";
  // marks were keyed calendar/id: a calendar move (same id) lost them
  for (const k of Object.keys(cache!)) {
    if (!k.includes("/")) continue;
    const id = k.slice(k.lastIndexOf("/") + 1);
    if (!cache![id]) cache![id] = cache![k];
    delete cache![k];
  }
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

/** by event id: Google keeps it across a calendar move */
export const reconKey = (e: { calendar_id: string; id: string }) => e.id;

export function reconOf(key: string): ReconStatus | null {
  return load()[key]?.s ?? null;
}

/** the mark on this event, if it was made for it as it is now: one made
 *  before the event ended belongs to a time it was moved from (a lesson
 *  canceled, then rescheduled to tomorrow, must be asked about again) */
export function markOf(e: CalendarEvent): ReconStatus | null {
  const m = load()[reconKey(e)];
  if (!m) return null;
  // a cancel holds while the event keeps the times it was canceled at,
  // ended or not (moved, it's on again)
  if (m.s === "canceled" && m.for) return m.for === cancelSig(e) ? "canceled" : null;
  return m.at >= eventDates(e).end.getTime() ? m.s : null;
}

// the instants, not the strings: a save rewrites the same time in another
// form ("…T07:00:00-04:00" → "…T07:00:00"), which dropped the cancel
const cancelSig = (e: CalendarEvent) => {
  const { start, end } = eventDates(e);
  return `${start.getTime()}|${end.getTime()}`;
};

/** Canceled: kept on the calendar, struck through, out of Insights and the
 *  native alerts — any event, upcoming or past. */
export const isCanceled = (e: CalendarEvent) => markOf(e) === "canceled";

export function setCanceled(e: CalendarEvent, on: boolean) {
  const m = load();
  if (on) m[reconKey(e)] = { s: "canceled", at: clockNow().getTime(), for: cancelSig(e) };
  else delete m[reconKey(e)];
  sinceCache = undefined;
  save();
}

/** Cancel or restore, undoably (right-click, the panel's ⋯ menu). */
export function toggleCanceled(e: CalendarEvent) {
  const key = reconKey(e);
  // the undo puts back the mark this replaced (a "Happened" canceled by
  // mistake, then ⌘Z, came back unreviewed)
  const prev = load()[key];
  const on = !isCanceled(e);
  setCanceled(e, on);
  recordUndo(on ? `Canceled “${e.summary}”` : `Restored “${e.summary}”`, async () => restoreMarks([[key, prev]]));
}

/** the canceled marks with their times, for the native alerts to skip */
export function canceledSigs(): [string, string][] {
  return Object.entries(load())
    .filter(([, m]) => m.s === "canceled" && m.for)
    .map(([id, m]) => [id, m.for!]);
}

/** an event re-created under a new id (an undone delete) keeps its mark */
export function carryRecon(fromId: string, toId: string) {
  const m = load();
  if (!m[fromId] || m[toId]) return;
  m[toId] = { ...m[fromId] };
  save();
}

/** An answer, undoable: ⌘Z takes the mark back (it used to leave the mark
 *  and undo whatever edit lay under it). */
export function setRecon(key: string, s: ReconStatus | null, e?: CalendarEvent) {
  const prev = load()[key];
  writeRecon(key, s, e);
  const label = s === "done" ? "Marked as happened" : s === "canceled" ? "Marked as canceled" : "Cleared the review answer";
  recordUndo(e ? `${label}: “${e.summary}”` : label, async () => restoreMarks([[key, prev]]));
}

/** the morning banner's "All happened": one undo entry for the lot */
export function setReconAll(events: CalendarEvent[], s: ReconStatus) {
  const m = load();
  const prev = events.map((e) => [reconKey(e), m[reconKey(e)]] as [string, Mark | undefined]);
  for (const e of events) writeRecon(reconKey(e), s, e);
  recordUndo(`Marked ${events.length} event${events.length === 1 ? "" : "s"} as happened`, async () => restoreMarks(prev));
}

function restoreMarks(prev: [string, Mark | undefined][]) {
  const m = load();
  for (const [key, mark] of prev) {
    // (the event may have been deleted and brought back under a new id
    // since: the mark went with it, and so does its undo)
    const live = liveId(key);
    if (live !== key) delete m[key];
    if (mark) m[live] = { ...mark };
    else delete m[live];
  }
  sinceCache = undefined;
  save();
}

function writeRecon(key: string, s: ReconStatus | null, e?: CalendarEvent) {
  const m = load();
  if (s === null) delete m[key];
  else m[key] = { s, at: clockNow().getTime(), ...(s === "canceled" && e ? { for: cancelSig(e) } : {}) };
  sinceCache = undefined;
  if (s !== null) reconSince(); // pin the adoption date on the first review
  save();
}

/** When the user started reconciling (ms), or null if never. The focus
 *  score treats deep work that ended before (this − the review window) as
 *  history; after it, deep work must be confirmed to count in full. */
let sinceCache: number | null | undefined;
export function reconSince(): number | null {
  if (sinceCache !== undefined) return sinceCache;
  sinceCache = readSince();
  return sinceCache;
}
function readSince(): number | null {
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

/** sleep and all-day events reconcile themselves; nothing to check off.
 *  Neither does anything on someone else's calendar: only your copy of it. */
export function reconExempt(e: CalendarEvent, calendars: Calendar[]): boolean {
  // (nor an invitation you declined: it wasn't your time, as Insights and
  // the alerts already treat it)
  return e.all_day || classify(e, calendars) === "sleep" || readOnlyEvent(e, calendars) || myRsvp(e) === "declined";
}

export type ReconState = ReconStatus | "unsettled" | "unverified" | null;

/** null = not yet ended (or exempt); "unsettled" = ended, awaiting the user;
 *  "unverified" = aged out of the review window unconfirmed (counts half,
 *  can still be confirmed); "done" with no mark = from before reviewing */
export function reconState(
  e: CalendarEvent,
  calendars: Calendar[],
  now: Date,
): ReconState {
  const { end } = eventDates(e);
  // canceled ahead of time: struck through already
  if (end.getTime() > now.getTime()) return isCanceled(e) ? "canceled" : null;
  if (reconExempt(e, calendars)) return isCanceled(e) ? "canceled" : null;
  const explicit = markOf(e);
  if (explicit) return explicit;
  if (now.getTime() - end.getTime() > RECON_WINDOW_MS) {
    // grandfathered only if it predates reviewing (as the focus score has it)
    const since = reconSince();
    return since == null || end.getTime() < since - RECON_WINDOW_MS ? "done" : "unverified";
  }
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
