// Calendar colors (lib/color.ts, pure): calendars show the color Google
// Calendar itself displays, not the legacy hex its API reports.
import { expect, test } from "@playwright/test";
import { GCAL_DISPLAY, normalizeCalendarColor, oklch } from "../src/lib/color";

for (const dark of [true, false]) {
  const theme = dark ? "dark" : "light";

  test(`color (${theme}): legacy API colors become the exact color Google Calendar shows`, () => {
    // read off the live Google Calendar sidebar for these calendars
    const seen: [string, string, string][] = [
      ["Distractions", "#ac725e", "#795548"], // Cocoa: brown, not pink
      ["Family", "#cca6ac", "#ad1457"], // Radicchio
      ["Enrichment", "#b3dc6c", "#c0ca33"],
      ["Class", "#4986e7", "#3f51b5"],
      ["Career", "#9a9cff", "#7986cb"],
      ["Homework", "#fad165", "#f6bf26"],
      ["Learning and Research", "#f83a22", "#d50000"],
      ["Meets", "#cd74e6", "#8e24aa"],
      ["Sleep", "#16a765", "#0b8043"],
      ["Fitness", "#92e1c0", "#33b679"],
    ];
    for (const [name, api, shown] of seen) expect(normalizeCalendarColor(api, dark), name).toBe(shown);
    expect(Object.keys(GCAL_DISPLAY)).toHaveLength(24);
  });

  test(`color (${theme}): a custom color passes through untouched unless it would vanish`, () => {
    expect(normalizeCalendarColor("#ed201d", dark)).toBe("#ed201d");
    const black = normalizeCalendarColor("#000000", dark);
    if (dark) expect(oklch(black)[0]).toBeGreaterThan(0.5);
    else expect(black).toBe("#000000");
    const white = normalizeCalendarColor("#ffffff", dark);
    if (dark) expect(white).toBe("#ffffff");
    else expect(oklch(white)[0]).toBeLessThan(0.83);
  });
}
