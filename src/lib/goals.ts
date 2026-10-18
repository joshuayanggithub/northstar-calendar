// Goals: daily, weekly and long-term, kept by the app itself (the native app
// stores goals.json in its data folder, src-tauri/src/goals.rs, where the
// classifier reads the same list; the browser mock keeps them in memory).
// A daily goal's tick lasts the day, a weekly goal's the week; a long-term
// goal stays ticked until unticked.

import { useEffect, useState } from "react";
import { now, toDateOnly, weekStart } from "./dates";
import type { Backend } from "./types";

export type Horizon = "daily" | "weekly" | "long";

export const HORIZONS: { key: Horizon; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "long", label: "Long-term" },
];

export interface Goal {
  id: string;
  text: string;
  horizon: Horizon;
}

/** a line of the thought dump: something to think about, not a goal */
export interface Thought {
  id: string;
  text: string;
}

export interface GoalsFile {
  goals: Goal[];
  /** goal id -> the period it was ticked in */
  checks: Record<string, string>;
  /** the thought dump, kept in the same file (absent in older files) */
  thoughts?: Thought[];
}

/** the period a tick belongs to: this day, this week, or for good */
export function periodOf(h: Horizon, d = now()): string {
  if (h === "daily") return toDateOnly(d);
  if (h === "weekly") return "w" + toDateOnly(weekStart(d));
  return "done";
}

export const isDone = (f: GoalsFile, g: Goal, d = now()) => f.checks[g.id] === periodOf(g.horizon, d);

let cache: GoalsFile | null = null;
let loadedFrom: Backend | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(backend: Backend) {
  try {
    cache = await backend.goalsRead();
  } catch {
    cache = cache ?? { goals: [], checks: {} };
  }
  loadedFrom = backend;
  emit();
}

async function save(backend: Backend, next: GoalsFile) {
  cache = next;
  emit();
  await backend.goalsWrite(next);
}

let seq = 0;
const newId = () => `g${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The goals, live, and the edits on them. */
export function useGoals(backend: Backend | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!backend) return;
    if (loadedFrom !== backend) void load(backend);
    return backend.onGoalsChanged(() => void load(backend));
  }, [backend]);
  // a tick from yesterday must read as unticked after midnight
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const file = cache ?? { goals: [], checks: {} };
  const edit = (fn: (f: GoalsFile) => GoalsFile) => {
    if (backend) void save(backend, fn(cache ?? { goals: [], checks: {} }));
  };
  return {
    file,
    loading: !cache,
    isDone: (g: Goal) => isDone(file, g),
    add: (horizon: Horizon, text: string) =>
      edit((f) => ({ ...f, goals: [...f.goals, { id: newId(), text: text.trim(), horizon }] })),
    rename: (id: string, text: string) =>
      edit((f) => ({ ...f, goals: f.goals.map((g) => (g.id === id ? { ...g, text: text.trim() } : g)) })),
    remove: (id: string) =>
      edit((f) => {
        const checks = { ...f.checks };
        delete checks[id];
        return { ...f, goals: f.goals.filter((g) => g.id !== id), checks };
      }),
    thoughts: file.thoughts ?? [],
    addThought: (text: string) =>
      edit((f) => ({ ...f, thoughts: [...(f.thoughts ?? []), { id: newId(), text: text.trim() }] })),
    editThought: (id: string, text: string) =>
      edit((f) => ({
        ...f,
        thoughts: text.trim()
          ? (f.thoughts ?? []).map((t) => (t.id === id ? { ...t, text: text.trim() } : t))
          : (f.thoughts ?? []).filter((t) => t.id !== id),
      })),
    removeThought: (id: string) =>
      edit((f) => ({ ...f, thoughts: (f.thoughts ?? []).filter((t) => t.id !== id) })),
    toggle: (g: Goal) =>
      edit((f) => {
        const checks = { ...f.checks };
        if (isDone(f, g)) delete checks[g.id];
        else checks[g.id] = periodOf(g.horizon);
        return { ...f, checks };
      }),
  };
}
