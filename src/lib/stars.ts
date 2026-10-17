// Goal stars: mark an event as advancing one of your goals (or just
// star it). v1 persists locally (localStorage) — single-device by design;
// syncing through Google extendedProperties is the logged follow-up. Keys are
// `${calendar_id}/${event_id}` so recurring instances star individually.

export interface StarEntry {
  goal?: string; // the goal task's text from the goals .md, when linked
  /** user said "not goal work": keeps the auto-classifier from re-starring */
  suppressed?: boolean;
}

type Listener = () => void;

const KEY = "goal-stars";
let cache: Record<string, StarEntry> | null = null;
const listeners = new Set<Listener>();

function load(): Record<string, StarEntry> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    cache = {};
  }
  return cache!;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache ?? {}));
  } catch {
    /* private mode: stars stay in-memory for the session */
  }
  listeners.forEach((l) => l());
}

export const starKey = (e: { calendar_id: string; id: string }) => `${e.calendar_id}/${e.id}`;

export function getStar(key: string): StarEntry | null {
  return load()[key] ?? null;
}

export function isStarred(key: string): boolean {
  const e = load()[key];
  return !!e && !e.suppressed;
}

// ---- auto-classification layer (local LLM suggestions; hollow stars) ----

let autoGoals: Record<string, string> = {};

export function setAutoGoals(map: Record<string, string>) {
  autoGoals = map;
  listeners.forEach((l) => l());
}

export type StarState =
  | { kind: "manual"; goal?: string }
  | { kind: "auto"; goal: string }
  | null;

/** manual always wins (including explicit suppression); else the suggestion */
export function starState(key: string): StarState {
  const e = load()[key];
  if (e) return e.suppressed ? null : { kind: "manual", goal: e.goal };
  const auto = autoGoals[key];
  return auto ? { kind: "auto", goal: auto } : null;
}

/** confirm an auto suggestion into a real star */
export function confirmAuto(key: string) {
  const g = autoGoals[key];
  if (g) setStarGoal(key, g);
}

export function toggleStar(key: string): boolean {
  const m = load();
  const now = !(key in m);
  if (now) m[key] = {};
  else delete m[key];
  save();
  return now;
}

export function setStarGoal(key: string, goal: string | null) {
  const m = load();
  if (goal === null) {
    // clearing while a suggestion exists must stick as "not goal work"
    if (autoGoals[key]) m[key] = { suppressed: true };
    else delete m[key];
  } else {
    m[key] = { goal: goal || undefined };
  }
  save();
}

export function starsForGoal(goal: string): { manual: string[]; auto: string[] } {
  const manual = Object.entries(load())
    .filter(([, v]) => !v.suppressed && v.goal === goal)
    .map(([k]) => k);
  const manualSet = new Set(Object.keys(load()));
  const auto = Object.entries(autoGoals)
    .filter(([k, g]) => g === goal && !manualSet.has(k))
    .map(([k]) => k);
  return { manual, auto };
}

export function subscribeStars(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function starsSnapshot(): Record<string, StarEntry> {
  return load();
}
