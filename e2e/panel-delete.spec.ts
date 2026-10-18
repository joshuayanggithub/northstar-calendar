// The event panel's Delete and Save (EventPanel remove/save) and the Delete
// key on an open event. A delete left the panel's busy flag on; the panel
// stays mounted between events, so Save and Delete were disabled on every
// event opened after it. And with an event's panel open, Delete/Backspace
// did nothing (every single-key shortcut was off while a panel was open).
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t }).first();
const panel = (page: Page) => page.getByTestId("event-panel");

test("panel: after deleting one event, Save and Delete still work on the next ones", async ({ page }) => {
  await open(page);
  await chip(page, "Swim").click();
  await panel(page).getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".chip-timed", { hasText: "Swim" })).toHaveCount(0);

  // the next event: both buttons live; Save saves
  await chip(page, "Standup").click();
  await expect(panel(page).getByRole("button", { name: "Delete" })).toBeEnabled();
  await expect(panel(page).getByRole("button", { name: /^Save/ })).toBeEnabled();
  await panel(page).locator(".panel-title").fill("Standup (moved online)");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(chip(page, "Standup (moved online)")).toBeVisible();

  // and Delete deletes again
  await chip(page, "Client prep").click();
  await panel(page).getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".chip-timed", { hasText: "Client prep" })).toHaveCount(0);
});

test("panel: Delete / Backspace delete the open event, but not while typing in it", async ({ page }) => {
  await open(page);
  await chip(page, "Gym").click();
  await expect(panel(page)).toBeVisible();
  // typing in the title: Backspace edits the text
  await panel(page).locator(".panel-title").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await expect(panel(page).locator(".panel-title")).toHaveValue("Gy");
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toHaveCount(1);
  // out of the field: Delete deletes the event
  await page.locator(".panel-kind").click();
  await page.keyboard.press("Delete");
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Deleted");
  // one undo brings it back
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toHaveCount(1);
});

test("panel: a second Delete cannot resubmit while recurring scope is open", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as any;
    const backend = w.__mockBackend;
    const getMaster = backend.getSeriesMaster.bind(backend);
    w.__seriesMasterReads = 0;
    backend.getSeriesMaster = (...args: unknown[]) => {
      w.__seriesMasterReads++;
      return getMaster(...args);
    };
  });

  const recurringSleep = page.locator(".chip-timed:not(.chip-cfull)").filter({
    has: page.locator(".chip-title", { hasText: /^Sleep$/ }),
  }).first();
  await recurringSleep.click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByText("Repeats")).toBeVisible();
  await page.keyboard.press("Delete");
  const scope = page.getByTestId("scope-dialog");
  await expect(scope).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__seriesMasterReads)).toBe(1);

  await page.keyboard.press("Delete");
  await expect(scope).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__seriesMasterReads)).toBe(1);
});
