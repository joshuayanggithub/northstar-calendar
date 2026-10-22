// Isolate a calendar (sidebar right-click): a temporary view of just its
// events, with a way back (Show all / Escape), that changes no setting.
import { expect, test, type Page } from "@playwright/test";

const cal = (id: string, summary: string, color: string, extra: Record<string, unknown> = {}) =>
  ({ id, summary, color, is_primary: id === "primary", hidden: false, access_role: "owner", ...extra });
const CALS = [cal("primary", "Personal", "#4f8cff"), cal("work", "Work", "#2fbf71"), cal("gym", "Gym", "#e5484d", { hidden: true })];
const evt = (id: string, calId: string, summary: string, day: number) => ({
  id, calendar_id: calId, etag: null, summary, description: null, location: null,
  start: `2026-10-${day}T10:00:00-04:00`, end: `2026-10-${day}T11:00:00-04:00`, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
const EVENTS = [evt("p", "primary", "Dentist", 13), evt("w", "work", "Standup", 14), evt("g", "gym", "Leg day", 15)];

async function open(page: Page) {
  await page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, { calendars: CALS, events: EVENTS });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T08:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const row = (page: Page, name: string) => page.getByTestId("cal-row").filter({ hasText: name });
const titles = (page: Page) => page.locator(".chip-timed .chip-title").allTextContents();
const isolate = async (page: Page, name: string) => {
  await row(page, name).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
};
const hiddenFlags = (page: Page) => page.evaluate(async () =>
  Object.fromEntries((await (window as any).__mockBackend.listCalendars()).map((c: any) => [c.id, c.hidden])));

test("isolate: right-click a calendar shows only its events, and Show all brings the rest back", async ({ page }) => {
  await open(page);
  await expect.poll(async () => (await titles(page)).sort()).toEqual(["Dentist", "Standup"]);
  await isolate(page, "Work");
  await expect.poll(() => titles(page)).toEqual(["Standup"]);
  const pill = page.getByTestId("isolate-pill");
  await expect(pill).toContainText("Showing only Work");
  await expect(row(page, "Work")).toHaveClass(/isolated-cal/);
  await expect(row(page, "Personal")).toHaveClass(/hidden-cal/);
  // a view, not a setting
  expect(await hiddenFlags(page)).toEqual({ primary: false, work: false, gym: true });

  await pill.getByRole("button", { name: /Show all/ }).click();
  await expect(pill).toHaveCount(0);
  await expect.poll(async () => (await titles(page)).sort()).toEqual(["Dentist", "Standup"]);
  await expect(row(page, "Gym")).toHaveClass(/hidden-cal/); // still hidden, as before
});

test("isolate: Escape ends it (after clearing a selection); right-click offers Show all", async ({ page }) => {
  await open(page);
  await isolate(page, "Personal");
  await page.locator(".chip-timed", { hasText: "Dentist" }).click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Escape"); // closes the editor
  await page.keyboard.press("Escape"); // clears the selection
  await page.keyboard.press("Escape"); // ends the isolated view
  await expect(page.getByTestId("isolate-pill")).toHaveCount(0);
  await expect.poll(async () => (await titles(page)).sort()).toEqual(["Dentist", "Standup"]);

  await isolate(page, "Personal");
  await row(page, "Personal").click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: /Show all calendars/ }).click();
  await expect(page.getByTestId("isolate-pill")).toHaveCount(0);
});

test("isolate: a hidden calendar can be isolated; clicking another calendar switches to it", async ({ page }) => {
  await open(page);
  await isolate(page, "Gym");
  await expect.poll(() => titles(page)).toEqual(["Leg day"]);
  await row(page, "Work").click();
  await expect(page.getByTestId("isolate-pill")).toContainText("Showing only Work");
  await expect.poll(() => titles(page)).toEqual(["Standup"]);
  expect(await hiddenFlags(page)).toEqual({ primary: false, work: false, gym: true });
});

test("isolate: temporary, a reload shows every calendar again", async ({ page }) => {
  await open(page);
  await isolate(page, "Work");
  await expect(page.getByTestId("isolate-pill")).toBeVisible();
  await page.reload();
  await expect(page.locator(".mock-badge")).toBeVisible();
  await expect(page.getByTestId("isolate-pill")).toHaveCount(0);
  await expect.poll(async () => (await titles(page)).sort()).toEqual(["Dentist", "Standup"]);
});
