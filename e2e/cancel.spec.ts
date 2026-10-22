// Cancel an event (any, upcoming or past): kept on the calendar, lightened
// and struck through; restored by the same menu or ⌘Z; moved, it's on again.
import { expect, test, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const ev = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const EVENTS = [
  ev("m", "Team sync", "2026-10-15T14:00:00-04:00", "2026-10-15T15:00:00-04:00"),
  ev("h", "Holiday party", "2026-10-16", "2026-10-17", { all_day: true }),
];
async function open(page: Page) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [P], events: EVENTS });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
}
const chip = (page: Page) => page.locator(".chip-timed", { hasText: "Team sync" }).first();
const stored = (page: Page) => page.evaluate(async () => (await (window as any).__mockBackend
  .listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).filter((e: any) => e.summary === "Team sync"));

test("cancel: right-click an upcoming event → Cancel event: kept, lightened, struck through; ⌘Z restores", async ({ page }) => {
  await open(page);
  const before = await chip(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  await chip(page).click({ button: "right", position: { x: 6, y: 6 } });
  await page.getByTestId("ctx-cancel").click();
  await expect(chip(page)).toHaveClass(/canceled/);
  await expect(chip(page).locator(".chip-title").first()).toHaveCSS("text-decoration-line", "line-through");
  expect(await chip(page).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);
  expect(await stored(page)).toHaveLength(1); // still there, untouched
  await expect(page.getByTestId("toast")).toContainText("Canceled");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(chip(page)).not.toHaveClass(/canceled/);
});

test("cancel: from the panel's ⋯ menu, shown in the panel, month and list; Restore brings it back", async ({ page }) => {
  await open(page);
  await chip(page).click({ position: { x: 6, y: 6 } });
  const panel = page.getByTestId("event-panel");
  await panel.getByRole("button", { name: "More actions" }).click();
  await panel.getByTestId("panel-cancel").click();
  await expect(panel.getByTestId("panel-canceled")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  await expect(page.locator(".mchip", { hasText: "Team sync" })).toHaveClass(/canceled/);
  await page.keyboard.press("l");
  await expect(page.locator(".agenda-row", { hasText: "Team sync" })).toHaveClass(/canceled/);
  await page.keyboard.press("w");
  await chip(page).click({ position: { x: 6, y: 6 } });
  await panel.getByTestId("panel-canceled").getByRole("button", { name: "Restore" }).click();
  await expect(chip(page)).not.toHaveClass(/canceled/);
});

test("cancel: an all-day event can be canceled too", async ({ page }) => {
  await open(page);
  await page.locator(".chip-allday", { hasText: "Holiday party" }).click({ button: "right" });
  await page.getByTestId("ctx-cancel").click();
  await expect(page.locator(".chip-allday", { hasText: "Holiday party" })).toHaveClass(/canceled/);
});

test("cancel: a canceled event moved to a new time is on again", async ({ page }) => {
  await open(page);
  await chip(page).click({ button: "right", position: { x: 6, y: 6 } });
  await page.getByTestId("ctx-cancel").click();
  await expect(chip(page)).toHaveClass(/canceled/);
  await page.evaluate(async () => {
    const be = (window as any).__mockBackend;
    const e = (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).find((r: any) => r.id === "m");
    await be.updateEvent(e.id, { ...e, start: "2026-10-15T16:00:00-04:00", end: "2026-10-15T17:00:00-04:00" }, e.calendar_id);
  });
  await expect(chip(page)).not.toHaveClass(/canceled/);
});
