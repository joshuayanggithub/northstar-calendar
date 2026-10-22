// Month, list, ⌘K and Insights: found by the 2026-10-21 run 5 bug-finder
// (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const C = (id: string, summary: string, extra: Record<string, unknown> = {}) =>
  ({ id, summary, color: "#888888", is_primary: id === "p", hidden: false, access_role: "owner", ...extra });
const ev = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: !start.includes("T"),
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const NOW = "2026-10-21T09:00:00"; // a Wednesday
async function boot(page: Page, calendars: unknown[], events: unknown[], now = NOW) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars, events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const stored = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-10-01T00:00:00Z", "2026-11-30T00:00:00Z")).map((e: any) => e.summary as string));

// [P3] 1
test("⌘K: an Other-calendars event whose copy is on a hidden calendar is still found", async ({ page }) => {
  await boot(page, [C("p", "Personal"), C("cls", "Classes", { hidden: true }), C("school", "School", { access_role: "reader" })], [
    ev("lec", "school", "Lecture", "2026-10-22T10:00:00-04:00", "2026-10-22T11:00:00-04:00"),
    ev("lec-copy", "cls", "Lecture", "2026-10-22T10:00:00-04:00", "2026-10-22T11:00:00-04:00"), // same shape = a copy
  ]);
  // the grid shows the original (the copy's calendar is hidden) — passes
  await expect(page.locator(".chip-timed", { hasText: "Lecture" })).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").pressSequentially("lecture", { delay: 20 });
  await page.waitForTimeout(500);
  await expect(page.locator("[cmdk-item]", { hasText: "Lecture" })).toHaveCount(1);
  // got: 0 — no hit at all (original dropped as "copied", copy dropped as hidden)
});

// [P3] 2
test("insights › Coming up: two overlapping 9–11 blocks tomorrow are 2h scheduled, not 4h", async ({ page }) => {
  await boot(page, [C("p", "Personal"), C("w", "Work")], [
    ev("m1", "p", "Offsite", "2026-10-22T09:00:00-04:00", "2026-10-22T11:00:00-04:00"),
    ev("m2", "w", "Offsite prep", "2026-10-22T09:00:00-04:00", "2026-10-22T11:00:00-04:00"),
  ]);
  await page.keyboard.press("i");
  const thu = page.getByTestId("ins-forecast").locator(".ins-ahead-col").first();
  await expect(thu).toHaveAttribute("title", "Thu Oct 22: 2h scheduled");
  // got: "Thu Oct 22: 4h scheduled" (and the "typical day" it's compared with is a union, so overlap days read heavy)
});

// [P3] 3
test("month → week: an event opened in month view isn't deleted off-screen by Backspace in the week", async ({ page }) => {
  await boot(page, [C("p", "Personal")], [
    ev("far", "p", "Far meeting", "2026-10-28T10:00:00-04:00", "2026-10-28T11:00:00-04:00"),
    ev("near", "p", "Near meeting", "2026-10-22T10:00:00-04:00", "2026-10-22T11:00:00-04:00"),
  ]);
  await page.keyboard.press("m");
  await page.locator(".mchip", { hasText: "Far meeting" }).click(); // look at next week's meeting
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("w"); // this week, Oct 18–24: "Far meeting" isn't on screen
  await expect(page.locator(".chip-timed", { hasText: "Far meeting" })).not.toBeInViewport();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(400);
  expect(await stored(page)).toContain("Far meeting");
  // got: ["Near meeting"] — toast "Deleted “Far meeting”", an event nothing on screen showed as selected
});
