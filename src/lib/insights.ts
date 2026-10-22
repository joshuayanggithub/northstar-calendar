// Insight computations over the local event store. Pure functions, one
// consumable number per insight — the UI renders a stat, a delta and one
// sentence, never a paragraph.

import { eventDates, startOfDay } from "./dates";
import { myRsvp } from "./rsvp";
import { readOnlyEvent, type Calendar, type CalendarEvent } from "./types";
import { getPrefs, prefsVersion } from "./settings";

export interface DayBucket {
  date: Date;
  sleepH: number;
  distractionH: number;
  /** time on the deep-work calendars (Settings > Insights) */
  deepH: number;
  otherH: number;
  switches: number;
  longestBlockH: number;
  multitaskH: number;
}

/** Deep work is ONLY time on these calendars (the user's definition): not
 *  class, career, meetings or "work" in general. Matched by exact name. */
/** the deep-work calendars, as set in Settings > Insights */
export const deepCalendars = (): string[] => getPrefs().deepCalendars;
let deepSet: { v: number; set: Set<string> } | null = null;
export const isDeepCalendar = (name: string | undefined) => {
  if (!deepSet || deepSet.v !== prefsVersion()) {
    deepSet = { v: prefsVersion(), set: new Set(deepCalendars().map((n) => n.trim().toLowerCase())) };
  }
  return deepSet.set.has((name ?? "").trim().toLowerCase());
};
const SLEEP_CAL = /^sleep$/i;
const DISTRACTION_CAL = /distraction/i;

export type Kind = "sleep" | "distraction" | "deep" | "other";

export function classify(e: CalendarEvent, calendars: Calendar[]): Kind {
  const cal = calendars.find((c) => c.id === e.calendar_id)?.summary ?? "";
  if (SLEEP_CAL.test(cal.trim()) || /^(sleep|asleep|in bed)/i.test(e.summary)) return "sleep";
  if (DISTRACTION_CAL.test(cal) || /^distraction/i.test(e.summary)) return "distraction";
  if (isDeepCalendar(cal)) return "deep";
  return "other";
}

function hoursOf(e: CalendarEvent): number {
  const { start, end } = eventDates(e);
  return Math.max(0, (end.getTime() - start.getTime()) / 3600000);
}

type WSpan = [number, number, number];
/** length of the union of weighted spans, each instant at its largest weight */
function weightedUnionMs(list: WSpan[]): number {
  const cuts = [...new Set(list.flatMap(([a, b]) => [a, b]))].sort((x, y) => x - y);
  let total = 0;
  for (let k = 1; k < cuts.length; k++) {
    const a = cuts[k - 1];
    const b = cuts[k];
    let w = 0;
    for (const [s, e, ww] of list) if (s <= a && e >= b && ww > w) w = ww;
    total += (b - a) * w;
  }
  return total;
}

/** What an event counts for under review: null when canceled; deep work at
 *  what it settles to unreviewed (half once reviewing had started), so a
 *  block still waiting for review counts the same as it will once aged out
 *  and credit only rises, on confirmation. (Only deep work is reviewed:
 *  sleep and the rest never get a mark, and halving them halved last
 *  week's sleep.) */
function reviewWeight(e: CalendarEvent, kind: Kind, endMs: number, review: Review): number | null {
  const proof = proofOf(endMs, review.now.getTime(), review.recon(e), review.reconSince);
  if (proof === "canceled") return null;
  if (kind !== "deep") return 1;
  const settled = proof === "pending" ? proofOf(endMs, Infinity, null, review.reconSince) : proof;
  return settled === "unverified" ? FOCUS.unverified : 1;
}

/** Bucket timed events into local days over [from, to). */
export function bucketDays(
  events: CalendarEvent[],
  calendars: Calendar[],
  from: Date,
  to: Date,
  /** count only what has happened (up to `now`), as reviewed: canceled
   *  blocks not at all, ones aged out unconfirmed at half (as the score) */
  review?: { now: Date; recon: (e: CalendarEvent) => "done" | "canceled" | null; reconSince: number | null },
): DayBucket[] {
  const days: DayBucket[] = [];
  // calendar days (DST days are 23h/25h: a 24h step doubled Nov 1)
  for (let d = startOfDay(from); d < to; d = startOfDay(new Date(d.getTime() + 36 * 3600_000))) {
    days.push({
      date: new Date(d),
      sleepH: 0,
      distractionH: 0,
      deepH: 0,
      otherH: 0,
      switches: 0,
      longestBlockH: 0,
      multitaskH: 0,
    });
  }
  const idxOf = (t: Date) => Math.round((startOfDay(t).getTime() - startOfDay(from).getTime()) / 86400000);
  const timed = events.filter((e) => !e.all_day);

  // each day's stretches per kind: overlapping blocks are one stretch of
  // time (9-11 and 10-12 is 3h, not 4h), at the larger weight
  const spans = new Map<number, Map<Kind, WSpan[]>>();
  for (const e of timed) {
    const { start, end: fullEnd } = eventDates(e);
    const kind = classify(e, calendars);
    let weight = 1;
    let end = fullEnd;
    if (review) {
      const w = reviewWeight(e, kind, fullEnd.getTime(), review);
      if (w == null) continue;
      weight = w;
      if (end > review.now) end = review.now; // not yet happened
    }
    // split across days (DST days are 23h/25h: a 24h step never got past
    // 11 PM on Nov 1 and hung the app)
    let s = start;
    while (s < end) {
      const dayEnd = startOfDay(new Date(startOfDay(s).getTime() + 36 * 3600_000));
      const segEnd = end < dayEnd ? end : dayEnd;
      const i = idxOf(s);
      if (i >= 0 && i < days.length) {
        if (!spans.has(i)) spans.set(i, new Map());
        const byKind = spans.get(i)!;
        if (!byKind.has(kind)) byKind.set(kind, []);
        byKind.get(kind)!.push([s.getTime(), segEnd.getTime(), weight]);
        const h = ((segEnd.getTime() - s.getTime()) / 3600000) * weight;
        days[i].longestBlockH = Math.max(days[i].longestBlockH, kind !== "sleep" ? h : 0);
      }
      s = segEnd;
    }
  }
  for (const [i, byKind] of spans) {
    for (const [kind, list] of byKind) {
      const h = weightedUnionMs(list) / 3600000;
      if (kind === "sleep") days[i].sleepH += h;
      else if (kind === "distraction") days[i].distractionH += h;
      else if (kind === "deep") days[i].deepH += h;
      else days[i].otherH += h;
    }
  }

  // context switches + multitask per day (non-sleep events that happened)
  const byDay = new Map<number, { start: Date; end: Date; cal: string }[]>();
  for (const e of timed) {
    if (classify(e, calendars) === "sleep") continue;
    // a canceled block or one still ahead isn't a switch
    if (review && (review.recon(e) === "canceled" || eventDates(e).start >= review.now)) continue;
    const { start, end } = eventDates(e);
    const i = idxOf(start);
    if (i < 0 || i >= days.length) continue;
    if (!byDay.has(i)) byDay.set(i, []);
    byDay.get(i)!.push({ start, end, cal: e.calendar_id });
  }
  for (const [i, list] of byDay) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let k = 1; k < list.length; k++) {
      const gapMin = (list[k].start.getTime() - list[k - 1].end.getTime()) / 60000;
      if (gapMin < 30 && list[k].cal !== list[k - 1].cal) days[i].switches++;
    }
    // multitask: sweep for >=2 concurrent
    const pts: [number, number][] = [];
    for (const ev of list) pts.push([ev.start.getTime(), 1], [ev.end.getTime(), -1]);
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let depth = 0;
    let since = 0;
    for (const [t, dl] of pts) {
      if (depth >= 2 && t > since) days[i].multitaskH += (t - since) / 3600000;
      depth += dl;
      since = t;
    }
  }
  return days;
}

export const fmtH = (h: number): string => {
  // (minutes rounded first: 7.99h read "7h60")
  const t = Math.round(Math.abs(h) * 60);
  const hh = Math.floor(t / 60);
  const mm = t % 60;
  const sign = h < 0 ? "−" : "";
  if (hh === 0) return `${sign}${mm}m`;
  if (mm === 0) return `${sign}${hh}h`;
  return `${sign}${hh}h${String(mm).padStart(2, "0")}`;
};

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

/** Stddev of event start clock-times in minutes (bedtime consistency). */
export function clockVarianceMin(starts: Date[]): number {
  if (starts.length < 2) return 0;
  // circular-ish: anchor near the median by shifting times past 18:00 to negative
  const mins = starts.map((d) => {
    let m = d.getHours() * 60 + d.getMinutes();
    if (m > 18 * 60) m -= 1440;
    return m;
  });
  const m = avg(mins);
  return Math.sqrt(avg(mins.map((x) => (x - m) ** 2)));
}

// ---------------------------------------------------------------------------
// The focus score (design/focus-score.md). Pessimistic by construction: only
// confirmed time on the deep-work calendars counts, only its uninterrupted
// part, with diminishing returns per block and per day; distraction,
// interruptions and bad / late / irregular sleep then multiply it down.
//
//   score = 100 · Work^0.5 · Restraint^0.3 · Recovery^0.3   (0 with no deep work)

/** how long a past event waits for review before it ages out of the queue */
export const RECON_WINDOW_MS = 48 * 3600 * 1000;

export const FOCUS = {
  /** a clean stretch shorter than this (after re-immersion) is worth nothing */
  minSegment: 25,
  /** minutes of re-immersion lost after each interruption */
  recovery: 15,
  /** full credit for one ultradian cycle, half for the second, none after */
  blockFull: 90,
  blockHalf: 180,
  /** a sitting claimed longer than this is a placeholder, not focus: decays */
  plausible: 240,
  /** deep events closer than this are one sitting */
  sessionGap: 15,
  /** deliberate-practice ceiling per day */
  dayCap: 240,
  /** credited minutes for a full Work factor */
  target: 210,
  /** one full uninterrupted cycle for the longest-block term */
  longTarget: 90,
  /** deep work before this hour (after midnight) counts half */
  lateDeepUntil: 5,
  /** distraction from this hour to 05:00 the next morning counts twice */
  lateDistFrom: 23,
  /** time logged after it happened */
  retro: 0.6,
  retroGraceMin: 15,
  /** aged out of review without being confirmed */
  unverified: 0.5,
  /** Recovery when no sleep was measured */
  noSleep: 0.6,
  /** Restraint kept per interruption */
  interruptKeep: 0.95,
  /** distraction minutes that halve Restraint */
  distHalf: 120,
};

type Pts = [number, number][];
/** sleep hours -> factor */
const SLEEP_DUR: Pts = [[4, 0.15], [5, 0.4], [6, 0.65], [7, 0.9], [7.5, 1], [10, 1], [12, 0.85]];
/** onset clock hour (24+ = after midnight) -> factor */
const SLEEP_TIMING: Pts = [[24.5, 1], [25.5, 0.9], [27, 0.7], [29, 0.5], [30, 0.4]];
/** hours off the median onset of the previous week -> factor */
const SLEEP_REGULAR: Pts = [[1, 1], [2, 0.85], [4, 0.6]];

/** piecewise-linear lookup, flat beyond both ends */
export function piece(x: number, pts: Pts): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

/** credit for m clean minutes in one sitting (never decreasing) */
export function blockCredit(m: number): number {
  const { blockFull, blockHalf } = FOCUS;
  return Math.min(m, blockFull) + 0.5 * Math.max(0, Math.min(m, blockHalf) - blockFull);
}

/** How sure we are that a past event happened. Deep work only counts when
 *  the user confirmed it (or it predates reconciliation); one left to age out
 *  of the review queue counts half; one still in the queue counts nothing. */
export type Proof = "confirmed" | "history" | "unverified" | "pending" | "canceled";

export function proofOf(
  endMs: number,
  nowMs: number,
  explicit: "done" | "canceled" | null,
  reconSince: number | null,
): Proof {
  if (explicit === "canceled") return "canceled";
  if (endMs > nowMs) return "pending"; // still running: not done yet
  if (explicit === "done") return "confirmed";
  if (nowMs - endMs <= RECON_WINDOW_MS) return "pending";
  if (reconSince == null || endMs < reconSince - RECON_WINDOW_MS) return "history";
  return "unverified";
}

const localMidnight = (d: Date) => startOfDay(d).getTime();
/** local clock time `h` on the day starting at d0 (DST-safe) */
const atHour = (d0: number, h: number) => {
  const d = new Date(d0);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};
const nextDay = (d0: number) => localMidnight(new Date(d0 + 36 * 3600000));

type Span = [number, number];
/** total length of the union of spans clipped to [a, b) */
function unionLen(spans: Span[], a: number, b: number): number {
  const xs = spans
    .map(([s, e]) => [Math.max(s, a), Math.min(e, b)] as Span)
    .filter(([s, e]) => e > s)
    .sort((p, q) => p[0] - q[0]);
  let total = 0;
  let cur: Span | null = null;
  for (const x of xs) {
    if (cur && x[0] <= cur[1]) cur[1] = Math.max(cur[1], x[1]);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [x[0], x[1]];
    }
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

/** The night's main sleep: spans less than 3h apart are one block, and the
 *  longest block is the night (an evening or afternoon nap made the night
 *  start at 6:30 PM or end at 1:45 PM) */
function mainSleep(spans: Span[]): Span[] {
  const xs = [...spans].sort((p, q) => p[0] - q[0]);
  const blocks: { spans: Span[]; end: number }[] = [];
  for (const x of xs) {
    const last = blocks[blocks.length - 1];
    if (last && x[0] - last.end <= 3 * 3600000) {
      last.spans.push(x);
      last.end = Math.max(last.end, x[1]);
    } else blocks.push({ spans: [x], end: x[1] });
  }
  let best: Span[] = [];
  let bestLen = 0;
  for (const b of blocks) {
    const len = unionLen(b.spans, -Infinity, Infinity);
    if (len > bestLen) {
      best = b.spans;
      bestLen = len;
    }
  }
  return best;
}

export interface SleepNight {
  hours: number;
  /** clock hour of falling asleep; 24+ = after midnight */
  onset: number;
}

/** Measured sleep that ends the night before day d0 (the night that fuels
 *  the day): "Asleep…" entries from a tracker, or else non-recurring sleep
 *  events. A recurring "Sleep" block is a plan, not a measurement. */
export function sleepNight(events: CalendarEvent[], calendars: Calendar[], d0: number): SleepNight | null {
  const lo = d0 - 6 * 3600000;
  const hi = d0 + 14 * 3600000;
  const spans: Span[] = [];
  const fallback: Span[] = [];
  for (const e of events) {
    if (e.all_day || classify(e, calendars) !== "sleep") continue;
    const { start, end } = eventDates(e);
    const s = start.getTime();
    const en = end.getTime();
    if (en <= s || en < lo || en > hi) continue;
    if (/^asleep/i.test(e.summary)) spans.push([s, en]);
    else if (!e.recurring_event_id && !/^in bed/i.test(e.summary)) fallback.push([s, en]);
  }
  const use = mainSleep(spans.length ? spans : fallback);
  if (!use.length) return null;
  const first = new Date(Math.min(...use.map((x) => x[0])));
  const h = first.getHours() + first.getMinutes() / 60;
  return {
    hours: unionLen(use, -Infinity, Infinity) / 3600000,
    onset: h < 15 ? h + 24 : h,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface FocusInput {
  /** any time on the day being scored */
  day: Date;
  now: Date;
  /** count only what happened before this (default now): last week's day
   *  up to this moment, against this week so far */
  until?: Date;
  /** events around the day: the week before (sleep regularity) to the next
   *  morning (late-night distraction) */
  events: CalendarEvent[];
  calendars: Calendar[];
  /** the user's explicit reconciliation of an event, if any */
  recon?: (e: CalendarEvent) => "done" | "canceled" | null;
  /** when the user started reconciling (ms); older events are history */
  reconSince?: number | null;
}

export interface FocusScore {
  score: number;
  /** anything counted that day (a pending-only day shows no badge) */
  hasData: boolean;
  /** the three factors, 0–1 */
  work: number;
  restraint: number;
  recovery: number;
  /** credited deep minutes after every discount, capped */
  deepMin: number;
  /** deep minutes on the calendar that day (not canceled, already ended) */
  loggedMin: number;
  /** longest clean stretch, minutes */
  longestMin: number;
  interruptions: number;
  distractionMin: number;
  /** distraction from 23:00 to 05:00 the next morning (counted twice) */
  lateDistractionMin: number;
  /** largest distraction source that day */
  topDistraction: [string, number] | null;
  /** deep work waiting for review (counts nothing until confirmed) */
  pendingMin: number;
  /** deep work that aged out unconfirmed (half credit) */
  unverifiedMin: number;
  /** deep work logged after it happened (reduced credit) */
  retroMin: number;
  /** deep work between midnight and 05:00 (half credit) */
  lateDeepMin: number;
  sleep: (SleepNight & { dur: number; timing: number; regular: number; drift: number | null }) | null;
  /** awake time on other calendars: what doesn't count as deep work */
  otherMin: number;
  otherBy: [string, number][];
  /** the biggest loss, one terse line */
  reason: string;
}

export function focusScore(inp: FocusInput): FocusScore {
  const F = FOCUS;
  const d0 = localMidnight(inp.day);
  const d1 = nextDay(d0);
  const nowMs = inp.now.getTime();
  // what has happened by `until`; review status is still as of now
  const clipMs = Math.min(nowMs, inp.until?.getTime() ?? Infinity);
  const upto = Math.min(d1, clipMs);
  const lateDistA = atHour(d0, F.lateDistFrom);
  const lateDistB = atHour(d1, F.lateDeepUntil);
  const lateDeepB = atHour(d0, F.lateDeepUntil);
  const since = inp.reconSince ?? null;
  const calName = (id: string) => inp.calendars.find((c) => c.id === id)?.summary.trim() ?? "other";

  type Item = { e: CalendarEvent; kind: Kind; s: number; en: number; proof: Proof };
  const items: Item[] = [];
  for (const e of inp.events) {
    // someone else's calendar scores nothing until it's copied into yours,
    // and a declined invitation isn't time spent
    if (e.all_day || readOnlyEvent(e, inp.calendars) || myRsvp(e) === "declined") continue;
    const { start, end } = eventDates(e);
    const s = start.getTime();
    const en = end.getTime();
    if (en <= s || en <= d0 || s >= lateDistB) continue;
    const proof = proofOf(en, nowMs, inp.recon?.(e) ?? null, since);
    if (proof === "canceled") continue;
    items.push({ e, kind: classify(e, inp.calendars), s, en, proof });
  }
  // awake events that already started on this day: anything that isn't sleep
  // interrupts deep work, whether or not it was confirmed
  const awake = items.filter((i) => i.kind !== "sleep" && i.s < upto && i.en > d0);

  let deepMin = 0;
  let loggedMin = 0;
  let longest = 0;
  let bestCredit = 0;
  let interruptions = 0;
  let pendingMin = 0;
  let unverifiedMin = 0;
  let retroMin = 0;
  let lateDeepMin = 0;
  // Diminishing returns apply per SESSION: deep events less than a short
  // break apart are one sitting, and an event's interrupted stretches stay
  // in its sitting. So neither a micro-interruption nor splitting one block
  // into adjacent events resets the 90-minute curve; adding any event can
  // only remove credit.
  type Sitting = { a: number; b: number; m: number; mw: number; longestW: number };
  const sittings: Sitting[] = [];
  const deep = awake.filter((i) => i.kind === "deep").sort((p, q) => p.s - q.s);
  for (const dp of deep) {
    const a = Math.max(dp.s, d0);
    const b = Math.min(dp.en, upto);
    if (dp.proof === "pending") {
      pendingMin += (Math.min(b, nowMs) - a) / 60000;
      continue;
    }
    loggedMin += (b - a) / 60000;
    const proofW = dp.proof === "unverified" ? F.unverified : 1;
    if (dp.proof === "unverified") unverifiedMin += (b - a) / 60000;
    let sit = sittings[sittings.length - 1];
    if (!sit || a - sit.b >= F.sessionGap * 60000) {
      sit = { a, b, m: 0, mw: 0, longestW: 0 };
      sittings.push(sit);
    } else sit.b = Math.max(sit.b, b);
    const others = awake.filter((o) => o !== dp && o.en > a && o.s < b);
    interruptions += others.length;
    // the clean stretches between the other events
    const cuts = others.map((o) => [Math.max(o.s, a), Math.min(o.en, b)] as Span).sort((p, q) => p[0] - q[0]);
    const segs: Span[] = [];
    let cur = a;
    for (const [x, y] of cuts) {
      if (x > cur) segs.push([cur, x]);
      cur = Math.max(cur, y);
    }
    if (cur < b) segs.push([cur, b]);
    const created = Date.parse(dp.e.raw?.created ?? "");
    const retroUntil = Number.isFinite(created) ? created + F.retroGraceMin * 60000 : -Infinity;
    segs.forEach(([x, y], k) => {
      const m = (y - x) / 60000 - (k > 0 ? F.recovery : 0);
      if (m < F.minSegment) return;
      // weight: late-night time half, time logged after the fact reduced
      // (both are prefixes of the stretch, so they overlap in its first part)
      const len = y - x;
      const lateMs = Math.max(0, Math.min(y, lateDeepB) - x);
      const retroMs = Math.max(0, Math.min(y, retroUntil) - x);
      const bothMs = Math.min(lateMs, retroMs);
      const w =
        ((bothMs * 0.5 * F.retro +
          (lateMs - bothMs) * 0.5 +
          (retroMs - bothMs) * F.retro +
          (len - lateMs - retroMs + bothMs)) /
          len) *
        proofW;
      lateDeepMin += lateMs / 60000;
      retroMin += retroMs / 60000;
      sit.m += m;
      sit.mw += m * w;
      sit.longestW = Math.max(sit.longestW, m * w);
      longest = Math.max(longest, m);
    });
  }
  for (const sit of sittings) {
    if (sit.m <= 0) continue;
    // a sitting claimed longer than 4h is a placeholder, not focus
    const span = (sit.b - sit.a) / 60000;
    const plaus = span > F.plausible ? (F.plausible / span) ** 2 : 1;
    deepMin += blockCredit(sit.m) * (sit.mw / sit.m) * plaus;
    bestCredit = Math.max(bestCredit, Math.min(sit.longestW, F.blockFull) * plaus);
  }
  deepMin = Math.min(deepMin, F.dayCap);
  const work = 0.7 * Math.min(1, deepMin / F.target) + 0.3 * Math.min(1, bestCredit / F.longTarget);

  // distraction: counted whether or not it was confirmed; overlapping
  // entries are one stretch of time, not two
  const distSpans: Span[] = items
    .filter((i) => i.kind === "distraction" && i.s < clipMs)
    .map((i) => [i.s, Math.min(i.en, clipMs)] as Span);
  const distractionMin = unionLen(distSpans, d0, upto) / 60000;
  const lateDistractionMin = unionLen(distSpans, lateDistA, Math.min(lateDistB, clipMs)) / 60000;
  const restraint =
    (1 / (1 + ((distractionMin + lateDistractionMin) / F.distHalf) ** 1.5)) * F.interruptKeep ** interruptions;

  // recovery: last night's sleep: duration × timing × regularity (a Sleep
  // block canceled ahead of time, an all-nighter, isn't a night)
  const sleepEvents = inp.recon ? inp.events.filter((e) => inp.recon!(e) !== "canceled") : inp.events;
  const night = sleepNight(sleepEvents, inp.calendars, d0);
  let sleep: FocusScore["sleep"] = null;
  let recovery = F.noSleep;
  if (night) {
    const prev: number[] = [];
    for (let k = 1, d = d0; k <= 7; k++) {
      d = localMidnight(new Date(d - 12 * 3600000));
      const n = sleepNight(sleepEvents, inp.calendars, d);
      if (n) prev.push(n.onset);
    }
    const drift = prev.length >= 3 ? Math.abs(night.onset - median(prev)) : null;
    const dur = piece(night.hours, SLEEP_DUR);
    const timing = piece(night.onset, SLEEP_TIMING);
    const regular = drift == null ? 1 : piece(drift, SLEEP_REGULAR);
    sleep = { ...night, dur, timing, regular, drift };
    recovery = dur * timing * regular;
  }

  const score = work <= 0 ? 0 : Math.round(100 * work ** 0.5 * restraint ** 0.3 * recovery ** 0.3);

  // what else filled the day (not deep work)
  const otherTally = new Map<string, number>();
  const distTally = new Map<string, number>();
  for (const i of awake) {
    const m = (Math.min(i.en, upto) - Math.max(i.s, d0)) / 60000;
    if (m <= 0) continue;
    if (i.kind === "other" && i.proof !== "pending") {
      const c = calName(i.e.calendar_id);
      otherTally.set(c, (otherTally.get(c) ?? 0) + m);
    } else if (i.kind === "distraction") {
      const src = distractionSource(i.e.summary);
      distTally.set(src, (distTally.get(src) ?? 0) + m);
    }
  }
  const byMin = (m: Map<string, number>) => [...m].sort((x, y) => y[1] - x[1]);
  const otherBy = byMin(otherTally);
  const topDist = byMin(distTally)[0] ?? null;

  const counted = awake.some((i) => i.proof !== "pending" || i.kind === "distraction");
  const hasData = counted || night != null;

  const out: FocusScore = {
    score,
    hasData,
    work,
    restraint,
    recovery,
    deepMin,
    loggedMin,
    longestMin: longest,
    interruptions,
    distractionMin,
    lateDistractionMin,
    topDistraction: topDist,
    pendingMin,
    unverifiedMin,
    retroMin,
    lateDeepMin,
    sleep,
    otherMin: otherBy.reduce((t, [, m]) => t + m, 0),
    otherBy: otherBy.slice(0, 3),
    reason: "",
  };
  out.reason = hasData ? focusReason(out) : "";
  return out;
}

const fmtM = (m: number) => fmtH(m / 60);

export function fmtClock(onset: number): string {
  const h24 = Math.floor(onset) % 24;
  const mm = Math.round((onset - Math.floor(onset)) * 60);
  const h = h24 % 12 || 12;
  return `${h}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${h24 < 12 ? "AM" : "PM"}`;
}

/** The biggest loss as one line of numbers (no prose). */
export function focusReason(f: FocusScore): string {
  if (f.deepMin <= 0) {
    if (f.pendingMin >= 1) return `${fmtM(f.pendingMin)} deep work unconfirmed, not scored yet`;
    if (f.loggedMin > 0) return `Deep work ${fmtM(f.loggedMin)}, no clean 25m stretch`;
    return "No deep work logged";
  }
  const losses: [number, string][] = [
    [-0.5 * Math.log(f.work), workLine(f)],
    [
      -0.3 * Math.log(f.restraint),
      f.distractionMin + f.lateDistractionMin >= 15 || f.interruptions === 0
        ? `Distraction ${fmtM(f.distractionMin)}` +
          (f.lateDistractionMin >= 5 ? ` (${fmtM(f.lateDistractionMin)} after 11 PM)` : "") +
          (f.topDistraction ? ` · top: ${f.topDistraction[0]}` : "")
        : `${f.interruptions} interruption${f.interruptions > 1 ? "s" : ""} during deep work`,
    ],
    [-0.3 * Math.log(f.recovery), sleepLine(f)],
  ];
  losses.sort((a, b) => b[0] - a[0]);
  return losses[0][0] < 0.03 ? "Near max on every part" : losses[0][1];
}

function workLine(f: FocusScore): string {
  const n = f.interruptions;
  if (n > 0 && f.loggedMin - f.deepMin >= 30) {
    return `${n} interruption${n > 1 ? "s" : ""} cut ${fmtM(f.loggedMin)} of deep work to ${fmtM(f.deepMin)}`;
  }
  if (f.deepMin >= FOCUS.target * 0.8 && f.longestMin < FOCUS.longTarget) {
    return `No ${FOCUS.longTarget}m uninterrupted block (longest ${fmtM(f.longestMin)})`;
  }
  return `Only ${fmtM(f.deepMin)} deep work (target ${fmtM(FOCUS.target)})`;
}

function sleepLine(f: FocusScore): string {
  const s = f.sleep;
  if (!s) return "No sleep tracked last night";
  const worst = Math.min(s.dur, s.timing, s.regular);
  if (worst === s.timing && s.timing < 1) return `Asleep at ${fmtClock(s.onset)}`;
  if (worst === s.regular && s.regular < 1 && s.drift != null) return `Bedtime ${fmtH(s.drift)} off your week`;
  return `Slept ${fmtH(s.hours)}`;
}

/** "Distraction: YouTube and Twitch" -> "YouTube" */
export function distractionSource(summary: string): string {
  return (summary.replace(/^distraction:?\s*/i, "").split(/[,/+&]| and /i)[0] || "other").trim();
}

export function topDistraction(events: CalendarEvent[], calendars: Calendar[]): [string, number] | null {
  const tally = new Map<string, number>();
  for (const e of events) {
    if (classify(e, calendars) !== "distraction") continue;
    const src = distractionSource(e.summary);
    tally.set(src, (tally.get(src) ?? 0) + hoursOf(e));
  }
  let best: [string, number] | null = null;
  for (const [k, v] of tally) if (!best || v > best[1]) best = [k, v];
  return best;
}

/** Median clock time + hit-rate within ±30min for a routine anchor title. */
export function routineStat(
  events: CalendarEvent[],
  title: RegExp,
  from: Date,
  to: Date,
): { days: number; hit: number; median: string } | null {
  const starts = events
    .filter((e) => !e.all_day && title.test(e.summary))
    .map((e) => eventDates(e).start)
    .filter((d) => d >= from && d < to);
  if (starts.length === 0) return null;
  const mins = starts.map((d) => d.getHours() * 60 + d.getMinutes()).sort((a, b) => a - b);
  const med = mins[Math.floor(mins.length / 2)];
  const hit = mins.filter((m) => Math.abs(m - med) <= 30).length;
  const h = Math.floor(med / 60) % 12 || 12;
  const ap = med < 720 ? "AM" : "PM";
  const mm = med % 60;
  return {
    days: starts.length,
    hit,
    median: `${h}${mm ? ":" + String(mm).padStart(2, "0") : ""}${ap}`,
  };
}

// ---- the Insights dashboard's breakdowns -------------------------------

export type Review = NonNullable<Parameters<typeof bucketDays>[4]>;

/** What of an event counts: the part that has happened, not canceled,
 *  unreviewed deep work at half once reviewing started (bucketDays' rules). */
function counted(e: CalendarEvent, calendars: Calendar[], review?: Review): { s: number; e: number; w: number } | null {
  if (e.all_day) return null;
  const { start, end } = eventDates(e);
  let s = start.getTime();
  let en = end.getTime();
  let w = 1;
  if (review) {
    const rw = reviewWeight(e, classify(e, calendars), en, review);
    if (rw == null) return null;
    w = rw;
    en = Math.min(en, review.now.getTime());
  }
  return en > s ? { s, e: en, w } : null;
}

/** Hours per calendar per local day over the given days (index-aligned). */
export function hoursByCalendar(
  events: CalendarEvent[],
  calendars: Calendar[],
  days: Date[],
  review?: Review,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!days.length) return out;
  const t0 = startOfDay(days[0]).getTime();
  const tEnd = startOfDay(new Date(days[days.length - 1].getTime() + 36 * 3600000)).getTime();
  const idx = (t: number) => Math.round((startOfDay(new Date(t)).getTime() - t0) / 86400000);
  for (const ev of events) {
    const c = counted(ev, calendars, review);
    if (!c || c.e <= t0 || c.s >= tEnd) continue;
    let s = Math.max(c.s, t0);
    const end = Math.min(c.e, tEnd);
    while (s < end) {
      const dayEnd = startOfDay(new Date(s + 36 * 3600000)).getTime();
      const segEnd = Math.min(end, dayEnd);
      const i = idx(s);
      if (i >= 0 && i < days.length) {
        if (!out.has(ev.calendar_id)) out.set(ev.calendar_id, days.map(() => 0));
        out.get(ev.calendar_id)![i] += ((segEnd - s) / 3600000) * c.w;
      }
      s = segEnd;
    }
  }
  return out;
}

export interface SleepWindow {
  date: Date;
  /** fell asleep / woke, as hours from the day's midnight (-1.5 = 10:30 PM before) */
  from: number;
  to: number;
  hours: number;
}

/** The night ending on each day: first sleep start to last wake (the same
 *  sources as the day score: "Asleep…" tracker entries first, else
 *  non-recurring sleep events). */
export function sleepWindows(events: CalendarEvent[], calendars: Calendar[], days: Date[]): (SleepWindow | null)[] {
  return days.map((d) => {
    const d0 = startOfDay(d).getTime();
    const lo = d0 - 6 * 3600000;
    const hi = d0 + 14 * 3600000;
    const tracked: Span[] = [];
    const other: Span[] = [];
    for (const e of events) {
      if (e.all_day || classify(e, calendars) !== "sleep") continue;
      const { start, end } = eventDates(e);
      const s = start.getTime();
      const en = end.getTime();
      if (en <= s || en < lo || en > hi) continue;
      if (/^asleep/i.test(e.summary)) tracked.push([s, en]);
      else if (!e.recurring_event_id && !/^in bed/i.test(e.summary)) other.push([s, en]);
    }
    const use = mainSleep(tracked.length ? tracked : other);
    if (!use.length) return null;
    const from = Math.min(...use.map((x) => x[0]));
    const to = Math.max(...use.map((x) => x[1]));
    // (as wall-clock hours from the day's midnight: elapsed hours read a
    // 7 AM wake after a spring-forward night as 6 AM)
    const wall = (t: number) => {
      const x = new Date(t);
      const days = Math.round((new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() - d0) / 86400000);
      return days * 24 + x.getHours() + x.getMinutes() / 60;
    };
    return { date: d, from: wall(from), to: wall(to), hours: unionLen(use, -Infinity, Infinity) / 3600000 };
  });
}

/** Hours of a kind by weekday (0 = Sunday) and clock hour. */
export function weekHourHeat(
  events: CalendarEvent[],
  calendars: Calendar[],
  from: Date,
  to: Date,
  kind: Kind,
  review?: Review,
): number[][] {
  // overlapping blocks count once, as in the headline (bucketDays): summed,
  // two overlapping distractions put "133%" of the time after 6 PM
  const spans = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => [] as WSpan[]));
  const a = from.getTime();
  const b = to.getTime();
  for (const ev of events) {
    if (classify(ev, calendars) !== kind) continue;
    const c = counted(ev, calendars, review);
    if (!c) continue;
    let s = Math.max(c.s, a);
    const end = Math.min(c.e, b);
    while (s < end) {
      const t = new Date(s);
      const hourEnd = new Date(t);
      hourEnd.setMinutes(60, 0, 0);
      const segEnd = Math.min(end, hourEnd.getTime());
      spans[t.getDay()][t.getHours()].push([s, segEnd, c.w]);
      s = segEnd;
    }
  }
  return spans.map((day) => day.map((list) => (list.length ? weightedUnionMs(list) / 3600000 : 0)));
}

/** Distraction hours by source ("Distraction: Twitch" -> Twitch), largest first. */
export function distractionBySource(
  events: CalendarEvent[],
  calendars: Calendar[],
  from: Date,
  to: Date,
  review?: Review,
): [string, number][] {
  // (a source's overlapping entries count once: two at once read "YouTube 2h"
  // of a 1h30 total)
  const spans = new Map<string, WSpan[]>();
  for (const ev of events) {
    if (classify(ev, calendars) !== "distraction") continue;
    const c = counted(ev, calendars, review);
    if (!c) continue;
    const s = Math.max(c.s, from.getTime()), e = Math.min(c.e, to.getTime());
    if (e <= s) continue;
    const src = distractionSource(ev.summary);
    const key = [...spans.keys()].find((k) => k.toLowerCase() === src.toLowerCase()) ?? src;
    spans.set(key, [...(spans.get(key) ?? []), [s, e, 1]]);
  }
  return [...spans.entries()].map(([k, l]) => [k, weightedUnionMs(l) / 3600000] as [string, number]).sort((x, y) => y[1] - x[1]);
}

/** "9 AM" / "12 PM" for a clock hour (0–24+). */
export function hourLabel(h: number): string {
  const hh = ((Math.round(h) % 24) + 24) % 24;
  return `${hh % 12 || 12} ${hh < 12 ? "AM" : "PM"}`;
}

/** The busiest `width`-hour window of a 24-slot profile: [start hour, share]. */
export function peakWindow(profile: number[], width = 3): [number, number] | null {
  const total = sum(profile);
  if (total <= 0) return null;
  let best = 0;
  let at = 0;
  for (let h = 0; h < 24; h++) {
    let s = 0;
    for (let k = 0; k < width; k++) s += profile[(h + k) % 24];
    // ties go to the window that starts where the work starts
    if (s > best || (s === best && profile[h] > profile[at])) {
      best = s;
      at = h;
    }
  }
  return [at, best / total];
}
