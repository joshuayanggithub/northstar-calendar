// The side panes resize (components/PaneResize.tsx): drag the sidebar's
// right edge or the event panel's left edge; the width is remembered,
// double-click resets it, arrow keys nudge it. Resizing never closes the
// open event. The description grows with its text (EventPanel
// GrowingTextarea) instead of scrolling inside a small box.
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}

const width = (page: Page, sel: string) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().width);

async function dragX(page: Page, testId: string, dx: number) {
  const b = (await page.getByTestId(testId).boundingBox())!;
  const y = b.y + 300;
  await page.mouse.move(b.x + b.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx / 2, y, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2 + dx, y, { steps: 3 });
  await page.mouse.up();
}

test("panes: drag the sidebar and the event panel wider; widths survive a reload; double-click resets", async ({ page }) => {
  await open(page);
  expect(await width(page, ".sidebar")).toBeCloseTo(232, 0);
  await dragX(page, "resize-pane-w-sidebar", 100);
  expect(await width(page, ".sidebar")).toBeCloseTo(332, 0);
  // the week makes room: the grid starts where the sidebar ends
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  expect(grid.x).toBeGreaterThanOrEqual(331);

  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  expect(await width(page, ".event-panel")).toBeCloseTo(316, 0);
  await dragX(page, "resize-pane-w-panel", -150);
  await expect(panel, "resizing doesn't close the event").toBeVisible();
  expect(await width(page, ".event-panel")).toBeCloseTo(466, 0);

  // never past its limit
  await dragX(page, "resize-pane-w-sidebar", -400);
  expect(await width(page, ".sidebar")).toBeCloseTo(190, 0);

  await page.reload();
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  expect(await width(page, ".sidebar")).toBeCloseTo(190, 0);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  expect(await width(page, ".event-panel")).toBeCloseTo(466, 0);

  // arrow keys nudge; double-click puts the default back
  await page.getByTestId("resize-pane-w-panel").focus();
  await page.keyboard.press("ArrowLeft");
  expect(await width(page, ".event-panel")).toBeCloseTo(482, 0);
  await page.getByTestId("resize-pane-w-panel").dblclick();
  expect(await width(page, ".event-panel")).toBeCloseTo(316, 0);
  await page.getByTestId("resize-pane-w-sidebar").dblclick();
  expect(await width(page, ".sidebar")).toBeCloseTo(232, 0);
});

test("panel: a long description shows in full, the box growing with it", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const desc = page.getByTestId("event-panel").locator(".panel-desc");
  const empty = (await desc.boundingBox())!.height;
  const text = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}: notes that run on for a while`).join("\n");
  await desc.fill(text);
  const full = await desc.evaluate((el: HTMLTextAreaElement) => ({ h: el.clientHeight, sh: el.scrollHeight }));
  expect(full.h).toBeGreaterThan(empty * 2);
  expect(full.sh - full.h, "nothing hidden inside the box").toBeLessThanOrEqual(1);
  // narrower panel: lines re-wrap and the box re-fits
  await dragX(page, "resize-pane-w-panel", -200);
  await desc.fill(text.replace(/\n/g, " "));
  const wide = await desc.evaluate((el: HTMLTextAreaElement) => ({ h: el.clientHeight, sh: el.scrollHeight }));
  expect(wide.sh - wide.h).toBeLessThanOrEqual(1);
  // short text: back to the usual size
  await desc.fill("short");
  expect((await desc.boundingBox())!.height).toBeCloseTo(empty, 0);
});
