// App preferences set in Settings (⌘,) that aren't a view's own state:
// the appearance and which calendars count as deep work. Kept in the
// webview's storage like the rest of the UI preferences.

import { useEffect, useState } from "react";
import type { ColorMode } from "./color";

export type Theme = "system" | "light" | "dark";

export interface Prefs {
  theme: Theme;
  /** calendar names whose time is deep work (Insights, the day score) */
  deepCalendars: string[];
  /** the red-pen margin notes on the week grid (A / ⇧⌘M toggles) */
  showNotes: boolean;
  /** invitations you declined, struck through (off: not shown) */
  showDeclined: boolean;
  /** event shading per theme: upcoming events' fill strength (%), and how
   *  much of that a past event keeps (%) */
  shade: { light: Shade; dark: Shade };
  /** calendar colors: balanced and kept distinguishable, or Google's exact */
  colorMode: ColorMode;
  /** colors picked in the app per calendar id (this app only, not Google) */
  calColors: Record<string, string>;
}

export interface Shade {
  upcoming: number;
  past: number;
}

/** the tokens.css values: dark mode is the quieter of the two (a fill reads
 *  stronger on near-black than on white) */
export const DEFAULT_SHADE: { light: Shade; dark: Shade } = {
  light: { upcoming: 55, past: 35 },
  dark: { upcoming: 44, past: 35 },
};
export const SHADE_RANGE = { upcoming: [20, 80], past: [10, 70] } as const;

export const DEFAULT_DEEP = ["Homework", "Learning and Research", "Enrichment"];
const DEFAULTS: Prefs = {
  theme: "system", deepCalendars: DEFAULT_DEEP, showNotes: true, showDeclined: true, shade: DEFAULT_SHADE,
  colorMode: "balanced", calColors: {},
};

const clampShade = (v: unknown, d: Shade): Shade => {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Shade>;
  const num = (x: unknown, def: number, [lo, hi]: readonly [number, number]) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : def;
  return { upcoming: num(o.upcoming, d.upcoming, SHADE_RANGE.upcoming), past: num(o.past, d.past, SHADE_RANGE.past) };
};
const KEY = "prefs";

function load(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      theme: p.theme === "light" || p.theme === "dark" ? p.theme : "system",
      deepCalendars: Array.isArray(p.deepCalendars) ? p.deepCalendars.filter((x: unknown) => typeof x === "string") : DEFAULT_DEEP,
      showNotes: p.showNotes !== false,
      showDeclined: p.showDeclined !== false,
      shade: {
        light: clampShade(p.shade?.light, DEFAULT_SHADE.light),
        dark: clampShade(p.shade?.dark, DEFAULT_SHADE.dark),
      },
      colorMode: p.colorMode === "google" ? "google" : "balanced",
      calColors: Object.fromEntries(
        Object.entries(p.calColors && typeof p.calColors === "object" ? p.calColors : {})
          .filter(([, v]) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v as string)),
      ) as Record<string, string>,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs: Prefs = load();
let version = 0;
const listeners = new Set<() => void>();

export const getPrefs = (): Prefs => prefs;
/** bumps on every change: caches keyed on it stay right */
export const prefsVersion = () => version;

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  version++;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* a private window: this session only */
  }
  if (patch.theme) applyTheme(prefs.theme);
  if (patch.shade) applyShade();
  listeners.forEach((l) => l());
}

export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePrefs(): Prefs {
  const [p, setP] = useState(prefs);
  useEffect(() => subscribePrefs(() => setP(prefs)), []);
  return p;
}

/** The window's appearance: in the app the native window's (which the
 *  webview's light/dark colors follow); in a browser, nothing to set. */
export function applyTheme(theme: Theme = prefs.theme) {
  try {
    document.documentElement.dataset.theme = theme;
  } catch {
    /* no document */
  }
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("set_app_theme", { theme: theme === "system" ? null : theme }).catch(() => {}),
    );
  }
}

/** Event shading (Settings › General): the chip tokens for each theme,
 *  written after the stylesheet so they win; the defaults write nothing. */
export function applyShade(shade = prefs.shade) {
  if (typeof document === "undefined") return;
  const same = (a: Shade, b: Shade) => a.upcoming === b.upcoming && a.past === b.past;
  const id = "shade-prefs";
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (same(shade.light, DEFAULT_SHADE.light) && same(shade.dark, DEFAULT_SHADE.dark)) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  const vars = (s: Shade) => `--chip-tint: ${s.upcoming}%; --past-fade: ${s.past / 100};`;
  el.textContent =
    `:root { ${vars(shade.light)} }\n` +
    `@media (prefers-color-scheme: dark) { :root { ${vars(shade.dark)} } }\n`;
}
