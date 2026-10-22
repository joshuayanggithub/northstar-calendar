// Navigation and view state: found by the 2026-10-21 run 5 bug-finder (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, nowIso = "2026-10-14T09:00:00") {
  await page.goto(`/?now=${encodeURIComponent(nowIso)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const heads = (page: Page) =>
  page.locator(".day-head").evaluateAll((els) => els.map((e) => e.getAttribute("data-day")));
const grid = (page: Page) => page.getByTestId("week-grid");
const scrollTop = (page: Page) => grid(page).evaluate((el) => el.scrollTop);

// [P2] Keep the hour in view when the number of shown days changes
test("w1d: a pinch that changes the day count keeps the hour the user scrolled to", async ({ page }) => {
  await open(page); // Wed Oct 14, 9:00; week Sun 11 – Sat 17
  await grid(page).evaluate((el) => (el.scrollTop = 11 * 48)); // 11 AM at the top
  expect(await scrollTop(page)).toBe(528);
  const g = (await grid(page).boundingBox())!;
  const x = g.x + g.width / 2, y = g.y + 300;
  // one trackpad pinch step (Chromium reports a pinch as ctrl+wheel)
  await page.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y)!.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -20, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }),
    );
  }, { x, y });
  await expect(page.locator(".day-head")).toHaveCount(6);
  expect(await scrollTop(page)).toBeCloseTo(528, -1); // got: 312 (jumped to 6:30 AM = now − 2.5h)
});

test("w1d: hiding weekends (⌘⇧E) keeps the hour the user scrolled to", async ({ page }) => {
  await open(page);
  await grid(page).evaluate((el) => (el.scrollTop = 11 * 48));
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.locator(".day-head")).toHaveCount(5);
  expect(await scrollTop(page)).toBeCloseTo(528, -1); // got: 312
});

// [P3] Leave Insights from the top bar's Today button, like T and Go › Today
test("w1d: the Today button in Insights goes to today's week", async ({ page }) => {
  await open(page);
  await page.keyboard.press("i");
  await expect(page.getByTestId("insights-view")).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByTestId("insights-view")).toHaveCount(0); // got: 1 (still Insights, title "Insights")
  await expect(page.locator(".day-head.today")).toHaveAttribute("data-day", "2026-10-14");
});

// [P3] Bring back the Sun–Sat week when weekends are turned back on
test("w1d: weekends off then on returns an unswiped week to Sun–Sat", async ({ page }) => {
  await open(page);
  const week = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"];
  expect(await heads(page)).toEqual(week);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.locator(".day-head")).toHaveCount(5);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.locator(".day-head")).toHaveCount(7);
  expect(await heads(page)).toEqual(week); // got: 2026-10-12 … 2026-10-18 (Mon–Sun)
});

// [P3] Keep the anchor's day of month when paging months
test("w1d: month next then previous returns to the same week", async ({ page }) => {
  await open(page, "2027-01-31T09:00:00"); // Sun Jan 31: week Jan 31 – Feb 6
  await page.keyboard.press("m");
  await page.keyboard.press("j"); // February (anchor clamped to Feb 28)
  await page.keyboard.press("k"); // January (anchor now Jan 28)
  await page.keyboard.press("w");
  await expect(page.locator(".day-head").first()).toHaveAttribute("data-day", "2027-01-31"); // got: 2027-01-24 (Jan 24 – 30, today not shown)
});

// [P3] Read a date-only ?now= as local midnight
test("w1d: ?now=YYYY-MM-DD makes that date today", async ({ page }) => {
  await page.goto("/?now=2026-10-14");
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await expect(page.locator(".day-head.today")).toHaveAttribute("data-day", "2026-10-14"); // got: 2026-10-13 (parsed as UTC midnight = Oct 13 8 PM EDT)
});
