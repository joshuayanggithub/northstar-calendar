// Goal stars: mark an event as advancing one of your goals (or just
// star it). v1 persists locally (localStorage) — single-device by design;
// syncing through Google extendedProperties is the logged follow-up. Keys are
// `${calendar_id}/${event_id}` so recurring instances star individually.

export interface StarEntry {
  goal?: string; // the goal task's text from the goals .md, when linked
  /** user said "not goal work": keeps the auto-classifier from re-starring */
  suppressed?: boolean;
  /** its event was deleted: kept for undo (carried to the re-created one),
   *  not counted (a goal's ★ badge counted a deleted event) */
  deleted?: boolean;
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
  // (a corrupt value blanked the whole window, with no way to clear
  // storage in the app: as recon, anything but an object of objects is
  // dropped)
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {};
  for (const k of Object.keys(cache!)) {
    const v = cache![k];
    if (!v || typeof v !== "object") delete cache![k];
  }
  // stars were keyed calendar/id: a calendar move (same id) lost them
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
    /* private mode: stars stay in-memory for the session */
  }
  listeners.forEach((l) => l());
}

/** by event id: Google keeps it across a calendar move */
export const starKey = (e: { calendar_id: string; id: string }) => e.id;

/** an event re-created under a new id (an undone delete) keeps its star */
export function carryStar(fromId: string, toId: string) {
  const m = load();
  if (!m[fromId] || m[toId]) return;
  const { deleted: _gone, ...rest } = m[fromId];
  m[toId] = { ...rest };
  save();
}

/** the event was deleted (undo may bring it back under a new id, or the
 *  same one for a recurring occurrence) */
export function markStarDeleted(key: string, deleted = true) {
  const m = load();
  if (!m[key]) return;
  if (deleted) m[key] = { ...m[key], deleted: true };
  else delete m[key].deleted;
  save();
}

/** a series was deleted (whole, or from the occurrence `fromId` on): its
 *  occurrences' stars (`<master>_<slot>`, the slot sorting by date) no
 *  longer count (a goal's ★ badge counted a deleted series' occurrence) */
export function markSeriesStarsDeleted(masterId: string, fromId?: string) {
  const m = load();
  const prefix = `${masterId}_`;
  let changed = false;
  for (const key of Object.keys(m)) {
    if (m[key].deleted) continue;
    const whole = key === masterId && !fromId;
    // (a slot suffix only: Google names a series it split off
    // `<master>_R<datetime>`, and that one still exists)
    const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : "";
    const occurrence = /^\d{8}(T\d{6}Z)?$/.test(suffix) && (!fromId || suffix >= fromId.slice(prefix.length));
    if (!whole && !occurrence) continue;
    m[key] = { ...m[key], deleted: true };
    changed = true;
  }
  if (changed) save();
}

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
  // (the classifier reports calendar/id keys)
  autoGoals = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.slice(k.lastIndexOf("/") + 1), v]));
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
  // a declined suggestion ({suppressed}) isn't a star: starring it stars it
  // (deleting the entry brought the declined suggestion back)
  const now = !(key in m) || !!m[key].suppressed;
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

/** a goal renamed: its starred events follow it (stars link by goal text) */
export function renameStarGoal(from: string, to: string) {
  if (from === to) return;
  const m = load();
  let changed = false;
  for (const v of Object.values(m)) {
    if (v.goal === from) {
      v.goal = to;
      changed = true;
    }
  }
  if (changed) save();
}

export function starsForGoal(goal: string): { manual: string[]; auto: string[] } {
  const manual = Object.entries(load())
    .filter(([, v]) => !v.suppressed && !v.deleted && v.goal === goal)
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
