// ⌘K palette and Insights: found by the 2026-10-18 bug-finder pass, run 2.
import { expect, test, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const HW = { id: "hw", summary: "Homework", color: "#e9a23b", is_primary: false, hidden: false, access_role: "owner" };
const WORK = { id: "work", summary: "Work", color: "#2fbf71", is_primary: false, hidden: true, access_role: "owner" };
const ev = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
async function open(page: Page, events: unknown[], init?: () => void) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [P, HW, WORK], events });
  if (init) await page.addInitScript(init);
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T14:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const day = (n: number, h: number) => new Date(2026, 9, 14 + n, h).toISOString();

test("⌘K: 'new' Enter makes a new event, not a time-zone change", async ({ page }) => {
  await open(page, []);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").pressSequentially("new", { delay: 30 });
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => localStorage.getItem("secondaryTz"))).toBe(null);
  await expect(page.getByTestId("event-panel")).toBeVisible();
});

test("⌘K: a series is found at its occurrence nearest now; upcoming hits aren't crowded out", async ({ page }) => {
  const weekly = Array.from({ length: 25 }, (_, k) => ev(`su_${k}`, "p", "Weekly sync", day(7 * (k - 12), 10), day(7 * (k - 12), 11), { recurring_event_id: "su" }));
  const old = Array.from({ length: 10 }, (_, k) => ev(`old${k}`, "p", `Review old ${k}`, day(-80 + k, 9), day(-80 + k, 10)));
  await open(page, [...weekly, ...old, ev("rt", "p", "Review tomorrow", day(1, 9), day(1, 10))]);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").fill("weekly sync");
  await expect(page.locator("[cmdk-item]", { hasText: "Weekly sync" }).locator(".cmdk-sub")).toHaveText("Oct 21");
  await page.locator(".cmdk input").fill("review");
  await expect(page.locator("[cmdk-item]", { hasText: "Review tomorrow" })).toBeVisible();
});

test("⌘K: no hits from hidden calendars; description matches are shown", async ({ page }) => {
  await open(page, [
    ev("s", "work", "Secret standup", day(1, 9), day(1, 10)),
    ev("d", "p", "Dentist", day(2, 9), day(2, 10), { description: "bring insurance card" }),
  ]);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").pressSequentially("secret", { delay: 20 });
  await page.waitForTimeout(400);
  expect(await page.locator("[cmdk-item]", { hasText: "Secret standup" }).count()).toBe(0);
  await page.locator(".cmdk input").fill("");
  await page.locator(".cmdk input").pressSequentially("insurance", { delay: 20 });
  await expect(page.locator("[cmdk-item]", { hasText: "Dentist" })).toBeVisible();
});

test("⌘K: Go to a date leaves Insights", async ({ page }) => {
  await open(page, []);
  await page.keyboard.press("i");
  await expect(page.getByTestId("insights-view")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").pressSequentially("dec 25", { delay: 20 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("insights-view")).toHaveCount(0);
});

test("insights: a canceled block and one not yet happened count no deep work", async ({ page }) => {
  await open(page, [
    ev("b", "hw", "Problem set", "2026-10-14T09:00:00-04:00", "2026-10-14T10:30:00-04:00"),
    ev("f", "hw", "Essay", "2026-10-14T18:00:00-04:00", "2026-10-14T20:00:00-04:00"),
  ], () => localStorage.setItem("recon", JSON.stringify({ b: { s: "canceled", at: Date.parse("2026-10-14T12:00:00-04:00") } })));
  await page.keyboard.press("i");
  await expect(page.getByTestId("ins-deepwork").locator(".ins-big")).toHaveText("0m");
});

test("insights: the top distraction is this week so far; the heatmap shows 28 days", async ({ page }) => {
  await open(page, [
    ev("r", "p", "Distraction: reddit", "2026-10-13T20:00:00-04:00", "2026-10-13T20:30:00-04:00"),
    ev("y", "p", "Distraction: YouTube", "2026-10-21T20:00:00-04:00", "2026-10-21T23:00:00-04:00"),
  ]);
  await page.keyboard.press("i");
  await expect(page.getByTestId("ins-distraction")).toContainText("reddit");
  await expect(page.getByTestId("ins-distraction")).not.toContainText("YouTube");
  await expect(page.locator(".ins-cell")).toHaveCount(28);
});

test("insights: sleep isn't halved once reviewing started", async ({ page }) => {
  const nights = [12, 13, 14].map((d) => ev(`s${d}`, "p", "Sleep", `2026-10-${d}T00:00:00-04:00`, `2026-10-${d}T08:00:00-04:00`));
  await open(page, nights, () => localStorage.setItem("recon-since", String(Date.parse("2026-10-01T12:00:00-04:00"))));
  await page.keyboard.press("i");
  await expect(page.getByTestId("ins-sleep").locator(".ins-big")).toHaveText("8h");
});

test("⌘K: a time zone is found by the name it shows", async ({ page }) => {
  await open(page, []);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").pressSequentially("new york", { delay: 20 });
  await expect(page.locator("[cmdk-item]", { hasText: "Eastern (New York)" })).toBeVisible();
});
