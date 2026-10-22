// Google-color → app-color conversion.
//
// The Calendar API still reports each calendar's color from Google's LEGACY
// palette (Cocoa = #ac725e, Radicchio = #cca6ac …), but Google Calendar itself
// paints the modern palette (Cocoa #795548, Radicchio #AD1457 …). Calendars
// take Google's exact displayed color; the chip styles make it translucent
// (color-mix with the background), Notion-style. The one adaptation: a color
// too close to the background to tint with (custom black on dark, white on
// light) is lifted / lowered just enough to show, keeping its hue.

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r),
    lg = srgbToLinear(g),
    lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const q = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${q(r)}${q(g)}${q(b)}`;
}

/** [L, C, hue°] of a hex color */
export function oklch(hex: string): [number, number, number] {
  const [L, a, b] = rgbToOklab(...(hexToRgb(hex) ?? [0, 0, 0]));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Legacy API calendar color → the color Google Calendar displays for it.
 *  Verified against the live Google Calendar sidebar (2026-10-16): Cocoa,
 *  Radicchio, Avocado, Blueberry, Lavender, Banana, Tomato, Grape, Basil,
 *  Sage; the rest follow the same table. */
export const GCAL_DISPLAY: Record<string, string> = {
  "#ac725e": "#795548", // Cocoa
  "#d06b64": "#e67c73", // Flamingo
  "#f83a22": "#d50000", // Tomato
  "#fa573c": "#f4511e", // Tangerine
  "#ff7537": "#ef6c00", // Pumpkin
  "#ffad46": "#f09300", // Mango
  "#42d692": "#009688", // Eucalyptus
  "#16a765": "#0b8043", // Basil
  "#7bd148": "#7cb342", // Pistachio
  "#b3dc6c": "#c0ca33", // Avocado
  "#fbe983": "#e4c441", // Citron
  "#fad165": "#f6bf26", // Banana
  "#92e1c0": "#33b679", // Sage
  "#9fe1e7": "#039be5", // Peacock
  "#9fc6e7": "#4285f4", // Cobalt
  "#4986e7": "#3f51b5", // Blueberry
  "#9a9cff": "#7986cb", // Lavender
  "#b99aff": "#b39ddb", // Wisteria
  "#c2c2c2": "#616161", // Graphite
  "#cabdbf": "#a79b8e", // Birch
  "#cca6ac": "#ad1457", // Radicchio
  "#f691b2": "#d81b60", // Cherry Blossom
  "#cd74e6": "#8e24aa", // Grape
  "#a47ae2": "#9e69af", // Amethyst
};

const cache = new Map<string, string>();

export function isDarkTheme(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

/** The color Google Calendar shows for a calendar, ready to tint in this
 *  theme. Exact unless it would vanish into the background. */
export function normalizeCalendarColor(hex: string | null | undefined, dark = isDarkTheme()): string {
  const fallback = dark ? "#9aa0a6" : "#6b7280";
  if (!hex) return fallback;
  const key = `${hex}|${dark ? "d" : "l"}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const shown = GCAL_DISPLAY[hex.trim().toLowerCase()] ?? hex.trim().toLowerCase();
  const rgb = hexToRgb(shown);
  if (!rgb) return fallback;
  const [L, a, b] = rgbToOklab(...rgb);
  // a tint of black on #191919 (or white on white) is invisible: bring it
  // to the edge of visibility, hue and chroma kept
  const L2 = dark ? (L < 0.3 ? 0.55 : L) : L > 0.93 ? 0.82 : L;
  const [r, g, bl] = L2 === L ? rgb : oklabToRgb(L2, a, b).map(clamp01);
  const result = toHex(r, g, bl);
  cache.set(key, result);
  return result;
}

// re-normalize when the OS theme flips
try {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => cache.clear());
} catch {
  /* non-browser */
}

// ---------- the calendars' palette: balanced and distinguishable ----------
//
// Google's colors vary a lot in weight (Banana is pale, Blueberry and Grape
// heavy, Graphite and Cocoa muddy), and calendars often share one: three on
// Blueberry tint to the same chip. "Balanced" keeps each calendar's hue but
// brings lightness and chroma into one band per theme, then nudges any
// calendar too close to one placed before it (hue first, then lightness) by
// the smallest step that tells them apart. Your own calendars are placed
// first, so they keep their color; one you picked yourself never moves.

export type ColorMode = "balanced" | "google";

/** lightness / chroma band the chips read best in, per theme */
const BAND = {
  light: { lo: 0.56, hi: 0.7, cmax: 0.19 },
  dark: { lo: 0.64, hi: 0.77, cmax: 0.17 },
};
/** OKLab distance two shown calendars' colors keep at least (tinted chips
 *  roughly halve it): near-duplicates only, so unique colors stay put */
export const DISTINCT = 0.075;

const fromOklch = (L: number, C: number, h: number): string => {
  // into sRGB, giving up chroma (not hue) until it fits
  for (let c = C; ; c -= 0.005) {
    const cc = Math.max(0, c);
    const rad = (h * Math.PI) / 180;
    const rgb = oklabToRgb(L, cc * Math.cos(rad), cc * Math.sin(rad));
    if (cc === 0 || rgb.every((x) => x >= -0.0005 && x <= 1.0005)) return toHex(...(rgb.map(clamp01) as [number, number, number]));
  }
};

const labOf = (hex: string) => rgbToOklab(...(hexToRgb(hex) ?? [0, 0, 0]));
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A Google color (legacy or exact) evened into this theme's band. */
export function balancedColor(hex: string | null | undefined, dark = isDarkTheme()): string {
  const base = normalizeCalendarColor(hex, dark);
  const [L, C, h] = oklch(base);
  const b = dark ? BAND.dark : BAND.light;
  return fromOklch(Math.min(hiFor(h, C, dark), Math.max(b.lo, L)), Math.min(C, b.cmax), h);
}

/** the band's top, higher for yellows and limes: held down to the others'
 *  lightness they turn mustard and olive */
function hiFor(h: number, C: number, dark: boolean): number {
  const b = dark ? BAND.dark : BAND.light;
  return C > 0.06 && h >= 60 && h <= 125 ? b.hi + (dark ? 0.05 : 0.11) : b.hi;
}

/** nudges tried in order of how far they move a color */
/** (a calendar stays in its hue family: at most ±36°, or deeper / paler.
 *  Mostly away from the page: a fill near the page's own lightness leaves a
 *  past event no room to fade, so light mode nudges darker, dark lighter) */
const nudges = (dark: boolean) => {
  const away = dark ? 1 : -1;
  const out: { dh: number; dL: number; cost: number }[] = [];
  for (const dh of [0, 12, -12, 24, -24, 36, -36])
    for (const dL of [0, 0.07 * away, 0.13 * away, -0.05 * away])
      out.push({ dh, dL, cost: Math.abs(dh) / 12 + Math.abs(dL) / 0.07 + (dL * away < 0 ? 1 : 0) });
  return out.sort((a, b) => a.cost - b.cost);
};
const NUDGES = { light: nudges(false), dark: nudges(true) };

/** Each calendar's chip color, by id. `calendars` in the sidebar's order;
 *  picked colors are placed first, then your own calendars, then the rest.
 *  Only shown calendars make room for each other: a hidden one takes the
 *  nearest free color but never moves a shown one. */
export function calendarPalette(
  calendars: { id: string; color: string | null; owned?: boolean; hidden?: boolean }[],
  opts: { mode: ColorMode; picked: Record<string, string> },
  dark: boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  if (opts.mode === "google") {
    for (const c of calendars) out.set(c.id, normalizeCalendarColor(opts.picked[c.id] ?? c.color, dark));
    return out;
  }
  const rank = (c: { id: string; owned?: boolean; hidden?: boolean }) =>
    (c.hidden ? 3 : 0) + (opts.picked[c.id] ? 0 : c.owned ? 1 : 2);
  const order = calendars.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i);
  const placed: number[][] = [];
  const b = dark ? BAND.dark : BAND.light;
  for (const { c } of order) {
    const picked = opts.picked[c.id];
    const base = balancedColor(picked ?? c.color, dark);
    if (picked) {
      out.set(c.id, base);
      if (!c.hidden) placed.push(labOf(base));
      continue;
    }
    const [L, C, h] = oklch(base);
    let best = base, bestMin = -1;
    for (const n of dark ? NUDGES.dark : NUDGES.light) {
      // (a gray has no hue to turn: only its lightness moves it)
      if (n.dh && C < 0.03) continue;
      // (lighter only so far: a pale fill leaves a past event no room to fade)
      const top = Math.min(hiFor(h, C, dark) + 0.08, dark ? 0.86 : 0.81);
      const hex = n.dh || n.dL ? fromOklch(Math.min(top, Math.max(b.lo - 0.1, L + n.dL)), C, (h + n.dh + 360) % 360) : base;
      const lab = labOf(hex);
      const nearest = placed.reduce((m, p) => Math.min(m, dist(lab, p)), Infinity);
      if (nearest >= DISTINCT) {
        best = hex;
        break;
      }
      if (nearest > bestMin + 1e-9) {
        best = hex;
        bestMin = nearest;
      }
    }
    out.set(c.id, best);
    if (!c.hidden) placed.push(labOf(best));
  }
  return out;
}

/** a dozen picks for "Color" in a calendar's menu: even steps round the wheel
 *  at the light theme's band (balanced per theme like any other) */
export const PICKS: { name: string; hex: string }[] = [
  ["Red", 27], ["Orange", 52], ["Amber", 78], ["Lime", 118], ["Green", 150], ["Teal", 185],
  ["Sky", 225], ["Blue", 262], ["Indigo", 285], ["Violet", 308], ["Pink", 345],
].map(([name, h]) => ({ name: name as string, hex: fromOklch(0.63, 0.15, h as number) }))
  .concat([{ name: "Brown", hex: fromOklch(0.6, 0.06, 55) }, { name: "Gray", hex: fromOklch(0.6, 0.005, 260) }]);
