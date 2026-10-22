// Calendar colors (2026-10-19): balanced and kept distinguishable, Google's
// exact on request, and a color picked per calendar in the sidebar.
import { expect, test, type Page } from "@playwright/test";
import { DISTINCT, PICKS, balancedColor, calendarPalette, oklch, rgbToOklab } from "../src/lib/color";

const cal = (id: string, summary: string, color: string, extra: Record<string, unknown> = {}) =>
  ({ id, summary, color, is_primary: id === "p", hidden: false, access_role: "owner", ...extra });
const ev = (id: string, calendar_id: string, summary: string, h: number) => ({
  id, calendar_id, etag: null, summary, description: null, location: null,
  start: `2026-10-14T${String(h).padStart(2, "0")}:00:00-04:00`, end: `2026-10-14T${String(h + 1).padStart(2, "0")}:00:00-04:00`,
  all_day: false, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
// three calendars on Blueberry, as Google often leaves them
const CALS = [cal("p", "Personal", "#4986e7"), cal("class", "Class", "#4986e7"), cal("grades", "Grades", "#4986e7"), cal("gym", "Gym", "#16a765")];
const EVENTS = [ev("a", "p", "Standup", 9), ev("b", "class", "Lecture", 11), ev("c", "grades", "Grading", 13), ev("d", "gym", "Lift", 15)];
async function open(page: Page) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: CALS, events: EVENTS });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T08:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}
const calOf = (page: Page, title: string) =>
  page.locator(".chip-timed", { hasText: title }).first().evaluate((el) => getComputedStyle(el).getPropertyValue("--cal").trim());
const lab = (hex: string) => { const v = parseInt(hex.slice(1), 16); return rgbToOklab(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255); };
const dist = (a: string, b: string) => { const x = lab(a), y = lab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const hueGap = (a: string, b: string) => { const d = Math.abs(oklch(a)[2] - oklch(b)[2]) % 360; return Math.min(d, 360 - d); };

test("palette: calendars sharing a Google color come apart; a unique one keeps its color", () => {
  for (const dark of [false, true]) {
    const pal = calendarPalette(CALS.map((c) => ({ ...c, owned: true })), { mode: "balanced", picked: {} }, dark);
    const blues = ["p", "class", "grades"].map((id) => pal.get(id)!);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(dist(blues[i], blues[j])).toBeGreaterThanOrEqual(DISTINCT - 1e-6);
    // each stays in its hue family, the first one exactly where balance puts it
    expect(blues[0]).toBe(balancedColor("#4986e7", dark));
    for (const b of blues) expect(hueGap(b, balancedColor("#4986e7", dark))).toBeLessThanOrEqual(37);
    expect(pal.get("gym")).toBe(balancedColor("#16a765", dark));
  }
});

test("palette: a hidden calendar never moves a shown one; a picked color never moves", () => {
  const shown = [{ id: "a", color: "#4986e7" }, { id: "b", color: "#4986e7", hidden: true, owned: true }];
  const pal = calendarPalette(shown, { mode: "balanced", picked: {} }, false);
  expect(pal.get("a")).toBe(balancedColor("#4986e7", false));
  const picked = calendarPalette([{ id: "a", color: "#4986e7", owned: true }, { id: "b", color: "#16a765" }], { mode: "balanced", picked: { b: "#4986e7" } }, false);
  expect(picked.get("b")).toBe(balancedColor("#4986e7", false));
  expect(dist(picked.get("a")!, picked.get("b")!)).toBeGreaterThanOrEqual(DISTINCT - 1e-6);
});

test("chips: three calendars on the same Google color draw three different colors", async ({ page }) => {
  await open(page);
  const cols = await Promise.all(["Standup", "Lecture", "Grading"].map((t) => calOf(page, t)));
  expect(new Set(cols).size).toBe(3);
  // Settings › Google's exact: the same color again, exactly Google's
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByTestId("settings").getByRole("radio", { name: "Google's exact" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => calOf(page, "Lecture")).toBe(await calOf(page, "Standup"));
});

test("sidebar: picking a calendar's color repaints it, survives a reload, and resets to Google's", async ({ page }) => {
  await open(page);
  const before = await calOf(page, "Lift");
  await page.getByTestId("cal-row").filter({ hasText: "Gym" }).click({ button: "right" });
  const pink = PICKS.find((p) => p.name === "Pink")!;
  await page.getByTestId("cal-colors").getByRole("button", { name: "Pink" }).click();
  await expect.poll(() => calOf(page, "Lift")).not.toBe(before);
  const picked = await calOf(page, "Lift");
  expect(hueGap(picked, pink.hex)).toBeLessThan(3);
  await page.reload();
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await expect.poll(() => calOf(page, "Lift")).toBe(picked);
  await page.getByTestId("cal-row").filter({ hasText: "Gym" }).click({ button: "right" });
  await expect(page.getByTestId("cal-colors").getByRole("button", { name: "Pink" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("cal-color-reset").click();
  await expect.poll(() => calOf(page, "Lift")).toBe(before);
});
