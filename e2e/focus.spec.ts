// The focus score (lib/insights.ts focusScore, pure): what counts as deep
// work, and that the obvious ways to game it don't pay. design/focus-score.md
import { expect, test } from "@playwright/test";
import { blockCredit, focusScore, piece, sleepNight, type FocusInput } from "../src/lib/insights";
import type { Calendar, CalendarEvent } from "../src/lib/types";

const cal = (id: string, summary: string): Calendar => ({
  id,
  summary,
  color: "#888888",
  is_primary: false,
  hidden: false,
  access_role: "owner",
});
const CALS = [
  cal("hw", "Homework"),
  cal("lr", "Learning and Research"),
  cal("en", " enrichment "), // names match trimmed, case-insensitive
  cal("cls", "Class"),
  cal("car", "Career"),
  cal("life", "Life"),
  cal("dis", "Distractions"),
  cal("slp", "Sleep"),
];

// the scored day: Tue Oct 13 2026 (local); "now" is Friday noon, so Tuesday
// is past the 48h review window and Thursday is still inside it
const DAY = new Date(2026, 9, 13);
const NOW = new Date(2026, 9, 16, 12, 0);
const at = (dayOff: number, h: number, m = 0) => new Date(2026, 9, 13 + dayOff, h, m);
const iso = (d: Date) => d.toISOString();

let n = 0;
function ev(calendar_id: string, summary: string, s: Date, e: Date, o: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: `e${n++}`,
    calendar_id,
    etag: null,
    summary,
    description: null,
    location: null,
    start: iso(s),
    end: iso(e),
    all_day: false,
    timezone: null,
    status: "confirmed",
    recurrence: null,
    recurring_event_id: null,
    conference_url: null,
    updated: null,
    ...o,
  };
}
/** a good night before the scored day: asleep 23:30, 8h */
const goodNight = (dayOff = 0) => ev("slp", "Asleep (8.0h)", at(dayOff - 1, 23, 30), at(dayOff, 7, 30));

function score(events: CalendarEvent[], o: Partial<FocusInput> = {}) {
  return focusScore({ day: DAY, now: NOW, events, calendars: CALS, reconSince: null, ...o });
}

test("focus: deep work is ONLY Homework, Learning and Research, Enrichment", () => {
  for (const id of ["cls", "car", "life"]) {
    const f = score([goodNight(), ev(id, "Problem set", at(0, 14), at(0, 16))]);
    expect(f.score, id).toBe(0);
    expect(f.hasData).toBe(true);
    expect(f.reason).toBe("No deep work logged");
  }
  for (const id of ["hw", "lr", "en"]) {
    expect(score([goodNight(), ev(id, "Problem set", at(0, 14), at(0, 16))]).score, id).toBeGreaterThan(50);
  }
});

test("focus: an ideal day (3.5h clean deep, 90m blocks, no distraction, 8h sleep) scores 100", () => {
  const evs = [
    goodNight(),
    ev("lr", "Read world-model papers", at(0, 9), at(0, 10, 30)),
    ev("hw", "Stats homework", at(0, 11), at(0, 12, 30)),
    ev("en", "Robotics talk notes", at(0, 14), at(0, 15)),
  ];
  const f = score(evs);
  expect(f.deepMin).toBeCloseTo(240, 0); // capped
  expect(f.score).toBe(100);
});

test("focus gaming: many tiny blocks earn nothing", () => {
  const evs = [goodNight()];
  for (let k = 0; k < 12; k++) evs.push(ev("lr", "skim", at(0, 8 + k, 0), at(0, 8 + k, 20)));
  const f = score(evs);
  expect(f.loggedMin).toBe(240);
  expect(f.deepMin).toBe(0);
  expect(f.score).toBe(0);
});

test("focus: one whole block beats the same time in pieces", () => {
  const whole = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 11))]);
  const pieces = score([
    goodNight(),
    ev("lr", "paper", at(0, 9), at(0, 9, 30)),
    ev("lr", "paper", at(0, 10), at(0, 10, 30)),
    ev("lr", "paper", at(0, 11), at(0, 11, 30)),
    ev("lr", "paper", at(0, 12), at(0, 12, 30)),
  ]);
  expect(whole.score).toBeGreaterThan(pieces.score);
  expect(whole.longestMin).toBe(120);
});

test("focus: an interruption costs its own time, 15m of re-immersion, and restraint", () => {
  const clean = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 12))]);
  const cut = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 12)), ev("life", "call", at(0, 10), at(0, 10, 10))]);
  expect(cut.interruptions).toBe(1);
  expect(cut.longestMin).toBe(170 - 60 - 15); // 10:10–12:00 less re-immersion
  expect(cut.score).toBeLessThan(clean.score);
  expect(cut.restraint).toBeLessThan(clean.restraint);
  expect(cut.reason).toBe("1 interruption cut 3h of deep work to 2h02");
  expect(score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 10))]).reason).toBe("Only 1h deep work (target 3h30)");
});

test("focus gaming: a distraction hidden under a deep block is cut out AND counted", () => {
  const clean = score([goodNight(), ev("hw", "HW", at(0, 14), at(0, 17))]);
  const hidden = score([
    goodNight(),
    ev("hw", "HW", at(0, 14), at(0, 17)),
    ev("dis", "Distraction: YouTube", at(0, 15), at(0, 16)),
  ]);
  expect(hidden.distractionMin).toBe(60);
  expect(hidden.topDistraction?.[0]).toBe("YouTube");
  expect(hidden.longestMin).toBe(60);
  expect(hidden.score).toBeLessThan(clean.score - 15);
});

test("focus gaming: double-booking deep work doesn't double it", () => {
  const one = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 11))]);
  const two = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 11)), ev("hw", "HW", at(0, 9), at(0, 11))]);
  expect(two.score).toBeLessThanOrEqual(one.score);
});

test("focus gaming: a 14h 'deep' placeholder scores below an honest 2h block", () => {
  const honest = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 11))]);
  const fake = score([goodNight(), ev("lr", "grind", at(0, 8), at(0, 22))]);
  expect(fake.deepMin).toBeLessThan(15);
  expect(fake.score).toBeLessThan(honest.score);
  expect(fake.score).toBeLessThan(40);
  // the same 14h as back-to-back hour events is still one placeholder sitting
  const chopped = [goodNight()];
  for (let h = 8; h < 22; h++) chopped.push(ev("lr", "grind", at(0, h), at(0, h + 1)));
  expect(score(chopped).deepMin).toBeLessThan(15);
});

test("focus gaming: a micro-interruption or an adjacent split never resets the 90m curve", () => {
  const whole = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 12))]);
  expect(blockCredit(180)).toBe(135);
  expect(whole.deepMin).toBe(135);
  const poked = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 12)), ev("life", "text", at(0, 10, 30), at(0, 10, 31))]);
  expect(poked.score).toBeLessThan(whole.score);
  const split = score([goodNight(), ev("lr", "paper", at(0, 9), at(0, 10, 30)), ev("hw", "HW", at(0, 10, 30), at(0, 12))]);
  expect(split.deepMin).toBe(135);
  expect(split.score).toBe(whole.score);
});

test("focus: daily cap — 8h of clean deep work credits at most 4h", () => {
  const evs = [goodNight()];
  for (let k = 0; k < 5; k++) evs.push(ev("lr", "block", at(0, 7 + 2 * k), at(0, 8 + 2 * k, 30)));
  expect(score(evs).deepMin).toBe(240);
});

test("focus: deep work after midnight counts half", () => {
  const day = score([goodNight(), ev("lr", "paper", at(0, 14), at(0, 16))]);
  const night = score([goodNight(), ev("lr", "paper", at(0, 2), at(0, 4))]);
  expect(night.lateDeepMin).toBe(120);
  expect(night.deepMin).toBeCloseTo(day.deepMin / 2, 5);
  expect(night.score).toBeLessThan(day.score);
});

test("focus: only reviewed deep work counts — pending zero, canceled gone, aged-out half", () => {
  const block = ev("lr", "paper", at(2, 9), at(2, 11)); // Thursday: inside the 48h review window
  const wed = { day: at(2, 0) };
  const night = goodNight(2);
  const pending = score([night, block], wed);
  expect(pending.pendingMin).toBe(120);
  expect(pending.deepMin).toBe(0);
  expect(pending.score).toBe(0);
  expect(pending.reason).toBe("2h deep work unconfirmed, not scored yet");
  const done = score([night, block], { ...wed, recon: () => "done" });
  expect(done.deepMin).toBe(105); // 90 full + 30 at half
  const canceled = score([night, block], { ...wed, recon: () => "canceled" });
  expect(canceled.loggedMin).toBe(0);
  expect(canceled.pendingMin).toBe(0);
  // past the window: before the user started reviewing it's history (full);
  // after, a never-confirmed block counts half
  const old = ev("lr", "paper", at(-10, 9), at(-10, 11));
  const before = score([old, goodNight(-10)], { day: at(-10, 0), reconSince: at(1, 0).getTime() });
  const after = score([old, goodNight(-10)], { day: at(-10, 0), reconSince: at(-20, 0).getTime() });
  expect(before.deepMin).toBe(105);
  expect(after.deepMin).toBe(52.5);
  expect(after.unverifiedMin).toBe(120);
});

test("focus gaming: distraction counts even when nobody confirmed it", () => {
  const evs = [goodNight(2), ev("lr", "paper", at(2, 9), at(2, 11)), ev("dis", "Distraction: Twitch", at(2, 20), at(2, 22))];
  const f = score(evs, { day: at(2, 0), recon: (e) => (e.calendar_id === "lr" ? "done" : null) });
  expect(f.distractionMin).toBe(120);
  expect(f.restraint).toBeLessThan(0.55);
});

test("focus: late-night distraction (23:00–05:00) counts twice", () => {
  const base = [goodNight(), ev("lr", "paper", at(0, 9), at(0, 11))];
  const afternoon = score([...base, ev("dis", "Distraction: Reddit", at(0, 15), at(0, 16))]);
  const late = score([...base, ev("dis", "Distraction: Reddit", at(0, 23, 30), at(1, 0, 30))]);
  expect(late.lateDistractionMin).toBe(60);
  expect(late.score).toBeLessThan(afternoon.score);
});

test("focus: bad, late, irregular sleep each cost; untracked sleep counts 60%", () => {
  const block = ev("lr", "paper", at(0, 9), at(0, 12));
  const good = score([goodNight(), block]);
  const short = score([ev("slp", "Asleep (4.5h)", at(0, 1), at(0, 5, 30)), block]);
  const late = score([ev("slp", "Asleep (8h)", at(0, 4, 30), at(0, 12, 30)), block]);
  const none = score([block]);
  expect(good.recovery).toBe(1);
  expect(short.score).toBeLessThan(good.score);
  expect(late.sleep?.timing).toBeLessThan(0.6);
  expect(late.reason).toBe("Asleep at 4:30 AM");
  expect(none.recovery).toBe(0.6);
  expect(none.reason).toBe("No sleep tracked last night");
  // regularity: same 8h, but 3h later than the previous week's bedtime
  const week = [1, 2, 3, 4, 5].map((k) => ev("slp", "Asleep", at(-k - 1, 23), at(-k, 7)));
  const regular = score([...week, ev("slp", "Asleep", at(-1, 23), at(0, 7)), block]);
  const shifted = score([...week, ev("slp", "Asleep", at(0, 2), at(0, 10)), block]);
  expect(regular.sleep?.regular).toBe(1);
  expect(shifted.sleep?.drift).toBeCloseTo(3, 5);
  expect(shifted.sleep!.regular).toBeLessThan(0.8);
});

test("focus gaming: a recurring 'Sleep' plan is not measured sleep", () => {
  const plan = ev("slp", "Sleep", at(-1, 23), at(0, 8), { recurring_event_id: "plan" });
  expect(sleepNight([plan], CALS, at(0, 0).getTime())).toBeNull();
  const logged = ev("slp", "Sleep", at(-1, 23), at(0, 7));
  expect(sleepNight([logged], CALS, at(0, 0).getTime())?.hours).toBe(8);
  // tracker entries win over a plan; in-bed time isn't sleep
  const evs = [plan, ev("slp", "In bed – falling asleep", at(-1, 23), at(-1, 23, 20)), ev("slp", "Asleep (6h)", at(-1, 23, 20), at(0, 5, 20))];
  expect(sleepNight(evs, CALS, at(0, 0).getTime())).toEqual({ hours: 6, onset: 23 + 20 / 60 });
});

test("focus gaming: deep work logged after it happened counts 60%", () => {
  const planned = ev("lr", "paper", at(0, 9), at(0, 11), { raw: { created: iso(at(-1, 20)) } });
  const after = ev("lr", "paper", at(0, 9), at(0, 11), { raw: { created: iso(at(0, 18)) } });
  const p = score([goodNight(), planned]);
  const a = score([goodNight(), after]);
  expect(p.retroMin).toBe(0);
  expect(a.retroMin).toBe(120);
  expect(a.deepMin).toBeCloseTo(p.deepMin * 0.6, 5);
});

test("focus: today scores the day so far; a block still running isn't counted yet", () => {
  const f = score([goodNight(3), ev("lr", "paper", at(3, 11), at(3, 13))], { day: at(3, 0) });
  expect(f.pendingMin).toBe(60);
  expect(f.deepMin).toBe(0);
});

test("focus property: adding a non-deep event never raises the score", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 300; k++) {
    const evs = [goodNight()];
    for (let i = 0; i < 1 + Math.floor(rand() * 4); i++) {
      const s = 7 + rand() * 14;
      evs.push(ev(["hw", "lr", "en"][i % 3], "deep", at(0, s), at(0, s + 0.4 + rand() * 3)));
    }
    const before = score(evs).score;
    const s = 6 + rand() * 18;
    const extra = ev(rand() < 0.5 ? "dis" : "life", rand() < 0.5 ? "Distraction: x" : "errand", at(0, s), at(0, s + rand() * 2));
    const after = score([...evs, extra]).score;
    expect(after, `case ${k}`).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThanOrEqual(100);
  }
});

test("focus: piecewise lookup is flat past both ends", () => {
  const pts: [number, number][] = [[4, 0.15], [7.5, 1], [12, 0.85]];
  expect(piece(2, pts)).toBe(0.15);
  expect(piece(20, pts)).toBe(0.85);
  expect(piece(7.5, pts)).toBe(1);
});
