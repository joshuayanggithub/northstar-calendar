// Keyboard shortcuts against design/references/notion-shortcuts.md: found by
// the 2026-10-18 bug-finder pass (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const chips = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const panel = (page: Page) => page.getByTestId("event-panel");

test("keys: ⌘C / ⌘Y in reconcile mode are not the C / Y answers", async ({ page }) => {
  await open(page);
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  const before = await pill.textContent();
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+y");
  await page.waitForTimeout(300);
  expect(await pill.textContent()).toBe(before);
});

test("keys: ⌘⇧D doesn't duplicate the selection", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j"); // Dentist is next week
  await chips(page, "Dentist").first().click();
  await page.locator(".panel-close[aria-label=Close]").click();
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await page.waitForTimeout(300);
  await expect(chips(page, "Dentist")).toHaveCount(1);
});

test("keys: ⌘⇧Z is not another undo", async ({ page }) => {
  await open(page);
  for (const t of ["Swim", "Workshop"]) {
    await chips(page, t).first().click();
    await panel(page).locator(".panel-kind").click();
    await page.keyboard.press("Delete");
    await expect(chips(page, t)).toHaveCount(0);
  }
  await page.keyboard.press("ControlOrMeta+z");
  await expect(chips(page, "Workshop")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(300);
  await expect(chips(page, "Swim")).toHaveCount(0);
});

test("keys: Escape in the command menu leaves the open editor and its edits", async ({ page }) => {
  await open(page);
  await chips(page, "Swim").first().click();
  await panel(page).locator(".panel-title").fill("Swim (moved)");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".cmdk input")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cmdk input")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator(".panel-title")).toHaveValue("Swim (moved)");
});

test("keys: Escape dismisses the recurring scope dialog, not the editor", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) }).first().click();
  await panel(page).locator(".panel-kind").click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("scope-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("scope-dialog")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
});

test("keys: Escape with the ⋯ menu open closes only the menu", async ({ page }) => {
  await open(page);
  await chips(page, "Swim").first().click();
  await panel(page).getByRole("button", { name: "More actions" }).click();
  await expect(page.getByTestId("panel-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("panel-menu")).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
});

test("keys: m after a swipe opens the month swiped to", async ({ page }) => {
  await open(page);
  const g = (await page.getByTestId("week-grid").boundingBox())!;
  const w = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(g.x + g.width / 2, g.y + 200);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(Math.round(w * 7), 0);
    await page.waitForTimeout(500);
  }
  await expect(page.locator(".topbar-title")).toHaveText("November 2026");
  await page.mouse.move(5, 5);
  await page.keyboard.press("m");
  await expect(page.locator(".topbar-title")).toHaveText("November 2026");
});

test("keys: ⌘⇧0 resets the zoom with the key a real keyboard sends", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+.");
  const zoomed = await page.locator(".chip-timed").first().evaluate((el) => el.getBoundingClientRect().height);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: ")", code: "Digit0", shiftKey: true, metaKey: navigator.platform.includes("Mac"), ctrlKey: !navigator.platform.includes("Mac"), bubbles: true,
  })));
  await expect.poll(() => page.locator(".chip-timed").first().evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(zoomed);
});

// Guessable aliases (2026-10-20, "make the shortcuts more intuitive"): the
// Notion keys stay; these are the ones you'd guess first.
test("shortcuts: ? opens the sheet, P selects the previous event, ⌘+ ⌘− ⌘0 zoom, ⇧⌘D hides declined", async ({ page }) => {
  await open(page);
  await page.keyboard.press("?");
  await expect(page.getByTestId("help")).toBeVisible();
  await expect(page.getByTestId("help")).toContainText("Review");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help")).toHaveCount(0);
  await page.keyboard.press("n");
  await page.keyboard.press("n");
  const second = await page.locator(".chip-timed.selected").first().textContent();
  await page.keyboard.press("p");
  const prev = await page.locator(".chip-timed.selected").first().textContent();
  expect(prev).not.toBe(second);
  await page.keyboard.press("Escape");
  const px = () => page.evaluate(() => Number(localStorage.getItem("hour-px") ?? 48));
  await page.keyboard.press("ControlOrMeta+=");
  await expect.poll(px).toBe(60);
  await page.keyboard.press("ControlOrMeta+-");
  await page.keyboard.press("ControlOrMeta+-");
  await expect.poll(px).toBe(36);
  await page.keyboard.press("ControlOrMeta+0");
  await expect.poll(px).toBe(48);
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("prefs") ?? "{}").showDeclined)).toBe(false);
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("prefs") ?? "{}").showDeclined)).toBe(true);
});

test("shortcuts: in review, N answers 'didn't happen' like X, and the card says so", async ({ page }) => {
  await open(page);
  await page.keyboard.press("r");
  const card = page.getByTestId("recon-pill");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("recon-btn-no").locator("kbd")).toHaveText("N");
  const total = Number((await card.locator(".recon-count").textContent())!.split(" of ")[1]);
  const first = await card.locator(".review-title").textContent();
  await page.keyboard.press("n");
  if (total > 1) await expect(card.locator(".review-title")).not.toHaveText(first!);
  else await expect(card).toHaveCount(0);
});
