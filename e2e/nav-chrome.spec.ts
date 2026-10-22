// Navigation, views and app chrome: found by the 2026-10-19 bug-finder pass.
// Every test here fails on the current code.
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, nowIso = "2026-10-14T09:00:00") {
  await page.goto(`/?now=${encodeURIComponent(nowIso)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const chips = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const panel = (page: Page) => page.getByTestId("event-panel");
const settings = (page: Page) => page.getByTestId("settings");
const title = (page: Page) => page.locator(".topbar-title");

test("nav: month and list views don't delete an event nothing shows as selected", async ({ page }) => {
  await open(page);
  await chips(page, "Standup").first().click();
  await page.keyboard.press("Escape"); // closes the editor, keeps the selection
  await page.keyboard.press("m");
  await expect(page.getByTestId("month-grid")).toBeVisible();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await expect(page.locator(".mchip", { hasText: "Standup" })).toHaveCount(1);
  await page.keyboard.press("n");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("nav: clicking inside Settings, Help or ⌘K keeps the open editor and its edits", async ({ page }) => {
  await open(page);
  await chips(page, "Standup").first().click();
  await panel(page).locator(".panel-title").fill("Standup (edited)");
  await page.keyboard.press("ControlOrMeta+,");
  await settings(page).getByRole("tab", { name: "Notifications" }).click();
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator(".panel-title")).toHaveValue("Standup (edited)");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("[cmdk-item]", { hasText: "Today" }).click();
  await expect(page.locator(".cmdk")).toHaveCount(0);
  await expect(panel(page).locator(".panel-title")).toHaveValue("Standup (edited)");
});

test("month: double-clicking an event chip opens that event, not an all-day draft", async ({ page }) => {
  await open(page);
  await page.keyboard.press("m");
  await page.locator(".mchip", { hasText: "Standup" }).first().dblclick();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator(".panel-title")).toHaveValue("Standup");
});

test("title: the list view names both months it spans; an N-day view names its days", async ({ page }) => {
  await open(page, "2026-10-25T09:00:00");
  await page.keyboard.press("l");
  await expect(page.locator(".agenda-day").last()).toContainText("Oct 30");
  await expect(title(page)).toHaveText("Oct – Nov 2026");
  await open(page, "2026-10-12T09:00:00");
  await page.keyboard.press("3");
  await expect(page.locator(".day-head")).toHaveCount(3);
  await expect(title(page)).toHaveText(/Oct(ober)? 12 ?– ?14, 2026/);
});

test("insights: picking a day in the mini-month leaves Insights; Next doesn't change the title", async ({ page }) => {
  await open(page);
  await page.keyboard.press("i");
  await expect(page.getByTestId("insights-view")).toBeVisible();
  const before = await title(page).textContent();
  await page.keyboard.press("j");
  await page.waitForTimeout(100);
  expect(await title(page).textContent()).toBe(before);
  await page.getByTestId("mini-month").getByRole("button", { name: "20", exact: true }).click();
  await expect(page.getByTestId("insights-view")).toHaveCount(0);
  await expect(page.locator(".day-head", { hasText: "20" })).toBeVisible();
});

test("quick create: a bare hour after a day word is a time", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const input = page.getByTestId("quick-create").locator("input");
  await input.fill("dinner tomorrow 7");
  await expect(page.locator(".qc-preview")).toHaveText("dinner · Thu, Oct 15 · 7:00 PM – 8:00 PM");
  await input.fill("call friday 3");
  await expect(page.locator(".qc-preview")).toHaveText("call · Fri, Oct 16 · 3:00 PM – 4:00 PM");
});

test("menu bar: Review Recent Events works while Settings is open", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings(page)).toBeVisible();
  await page.evaluate(() => (window as any).__menu("reconcile"));
  await expect(settings(page)).toHaveCount(0);
  await expect(page.getByTestId("recon-pill")).toBeVisible();
});

test("isolate: the pill doesn't cover the month title in a 900px window", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await open(page);
  await page.locator(".cal-row", { hasText: "Work" }).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
  const pill = (await page.getByTestId("isolate-pill").boundingBox())!;
  const t = (await title(page).boundingBox())!;
  const apart = pill.x >= t.x + t.width || pill.x + pill.width <= t.x || pill.y >= t.y + t.height || pill.y + pill.height <= t.y;
  expect(apart, "the pill's box meets the title's").toBe(true);
});

test("view switcher: the dropdown closes when the grid is clicked", async ({ page }) => {
  await open(page);
  await page.getByTestId("view-menu-btn").click();
  await expect(page.getByTestId("view-menu")).toBeVisible();
  await chips(page, "Standup").first().click();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("view-menu")).toHaveCount(0);
});
