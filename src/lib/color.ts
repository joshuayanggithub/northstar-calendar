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
