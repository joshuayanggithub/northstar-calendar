// Keyboard, focus and menu commands: found by the 2026-10-19 run 4 bug-finder
// (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, nowIso = "2026-10-14T09:00:00") {
  await page.goto(`/?now=${encodeURIComponent(nowIso)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const chips = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
const panel = (page: Page) => page.getByTestId("event-panel");
const sleepChip = (page: Page) =>
  page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) }).first();
const stored = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")).map((r: any) => r.summary as string));
const count = async (page: Page, title: string) => (await stored(page)).filter((s) => s === title).length;

// [P2] x in month view selects the event last hovered in the week view
test("keys5: x then ⌘D in month view never targets an event hovered before leaving the week", async ({ page }) => {
  await open(page);
  await chips(page, "Swim").first().hover(); // pointer on Swim when the view changes
  await page.keyboard.press("m");
  await expect(page.getByTestId("month-grid")).toBeVisible();
  await page.locator(".mchip", { hasText: "Dentist" }).first().hover();
  await page.keyboard.press("x");
  await page.keyboard.press("ControlOrMeta+d");
  await page.waitForTimeout(500);
  expect(await count(page, "Swim")).toBe(1); // got: 2 (toast "Duplicated “Swim”")
});

// [P2] the Enter that commits an IME composition submits / saves (Escape mid-composition also closes the editor)
test("keys5: Enter that commits an IME conversion doesn't submit quick create", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create").locator("input");
  await expect(qc).toBeFocused();
  await qc.pressSequentially("lunch ");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "あした", selectionStart: 3, selectionEnd: 3 });
  await page.keyboard.press("Enter"); // keydown: key "Enter", isComposing: true
  await page.waitForTimeout(400);
  await expect(page.getByTestId("quick-create")).toBeVisible(); // got: closed; "lunch あした" created
});

test("keys5: Enter that commits an IME conversion in the title does not save and close the editor", async ({ page }) => {
  await open(page);
  await chips(page, "Swim").first().click();
  const title = panel(page).locator(".panel-title");
  await title.click();
  await page.keyboard.press("End");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "すいえい", selectionStart: 4, selectionEnd: 4 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  await expect(panel(page)).toBeVisible(); // got: closed; "Swimすいえい" saved
});

// [P3] keys reach the calendar behind the recurring-scope dialog
test("keys5: the recurring delete dialog keeps the keyboard (no shortcuts behind it)", async ({ page }) => {
  await open(page);
  await sleepChip(page).click();
  await page.keyboard.press("Escape"); // editor closed, Sleep still selected
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("scope-dialog")).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("c");
  await page.keyboard.press("m");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("quick-create")).toHaveCount(0); // got: 1 (opened over the modal)
  await expect(page.getByTestId("month-grid")).toHaveCount(0);
});

// [P3] Escape in a sidebar text field also runs the calendar's Escape
test("keys5: Escape in a sidebar text field doesn't end the isolated calendar", async ({ page }) => {
  await open(page);
  await page.getByTestId("cal-row").filter({ hasText: "Work" }).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
  await expect(page.getByTestId("isolate-pill")).toBeVisible();
  const add = page.getByTestId("thought-add");
  await add.click();
  await add.fill("half a thought");
  await page.keyboard.press("Escape"); // leave the field
  await page.waitForTimeout(200);
  await expect(page.getByTestId("isolate-pill")).toBeVisible(); // got: 0 (isolation ended)
});

// [P3] Review mode keeps the keyboard when its event is opened over it
test("keys5: Escape closes the editor opened from Review, not the review card", async ({ page }) => {
  await open(page);
  await page.keyboard.press("r");
  const card = page.getByTestId("recon-pill");
  await expect(card).toBeVisible();
  await page.waitForTimeout(150); // (the key handler rebinds after the card paints)
  await page.keyboard.press("Enter"); // open the event under review
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await expect(panel(page)).toHaveCount(0); // got: 1 (editor stays)
  await expect(card).toBeVisible(); // got: 0 (review ended)
});

// [P3] Settings / Help are aria-modal but don't hold the focus
test("keys5: keyboard focus stays inside Help and Settings", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("help")).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  const inHelp = await page.evaluate(() => !!document.activeElement?.closest("[data-testid=help]"));
  expect(inHelp).toBe(true); // got: false (focus on a calendar chip behind the dialog)
});

// [P3] the right-click menu stays under ⌘K and takes its Escape
test("keys5: Escape closes ⌘K opened over the right-click menu", async ({ page }) => {
  await open(page);
  await chips(page, "Swim").first().click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".cmdk input")).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await expect(page.locator(".cmdk")).toHaveCount(0); // got: 1 (only the menu under it closed)
});

// [P3] Go › Review Recent Events does nothing while an editor is open
test("keys5: the Review Recent Events menu command works with an event open", async ({ page }) => {
  await open(page);
  await chips(page, "Swim").first().click();
  await expect(panel(page)).toBeVisible();
  await page.waitForTimeout(150);
  await page.evaluate(() => (window as any).__menu("reconcile"));
  await page.waitForTimeout(500);
  await expect(page.getByTestId("recon-pill")).toBeVisible(); // got: 0, and no toast
});

// WebKit with Full Keyboard Access off doesn't stop Tab on buttons: every Tab
// in a modal must be the trap's, not the browser's (Help had no stop of its
// own, and Tab left it for the Thought dump field behind it).
test("keys: every Tab in Help is handled by the dialog and moves to its next control", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("help")).toBeVisible();
  const r = await page.evaluate(() => {
    const dlg = document.querySelector('[data-testid="help"]')!;
    const items = [...dlg.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea")].filter((x) => x.getClientRects().length > 0);
    items[0].focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, moved: document.activeElement === items[1], count: items.length };
  });
  expect(r.count).toBeGreaterThan(2);
  expect(r.prevented, "the dialog handles Tab itself").toBe(true); // got: false (left to the browser)
  expect(r.moved, "focus on the dialog's next control").toBe(true);
});
