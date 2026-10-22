// Settings, notifications and the menu bar: found by the 2026-10-21 run 5
// bug-finder (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const ev = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});

/** loads the mock at Wed 2026-10-14 9:00 AM; links opened in a new tab
 *  (App.tsx openExternal) are recorded in window.__opened instead */
async function open(page: Page, events: unknown[] = [ev("w", "Reading", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00")]) {
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    (globalThis as any).__opened = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.target === "_blank") { (globalThis as any).__opened.push(this.href); return; }
      return click.call(this);
    };
  }, { calendars: [P], events });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const opened = (page: Page) => page.evaluate(() => (globalThis as any).__opened as string[]);
const menu = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__menu(c), cmd);
const settings = (page: Page) => page.getByTestId("settings");

// ---- [P2] Join Next Meeting (⌘J, Go menu) ----

// got: ["https://meet.example.com/declined"]
test("join: a declined invitation isn't the next meeting", async ({ page }) => {
  await open(page, [
    ev("dec", "Vendor pitch", "2026-10-14T09:30:00-04:00", "2026-10-14T10:00:00-04:00", {
      conference_url: "https://meet.example.com/declined",
      raw: { organizer: { email: "x@example.edu" }, attendees: [{ email: "me@example.edu", self: true, responseStatus: "declined" }] },
    }),
    ev("ok", "Team standup", "2026-10-14T10:00:00-04:00", "2026-10-14T10:30:00-04:00", { conference_url: "https://meet.example.com/standup" }),
  ]);
  await menu(page, "join");
  expect(await opened(page)).toEqual(["https://meet.example.com/standup"]);
});

// got: ["https://meet.example.com/november"] (a meeting four weeks out)
test("join: four weeks ahead in the grid, it's still today's meeting", async ({ page }) => {
  await open(page, [
    ev("today", "Team standup", "2026-10-14T10:00:00-04:00", "2026-10-14T10:30:00-04:00", { conference_url: "https://meet.example.com/today" }),
    ev("later", "Advisor 1:1", "2026-11-12T10:00:00-05:00", "2026-11-12T10:30:00-05:00", { conference_url: "https://meet.example.com/november" }),
  ]);
  for (let i = 0; i < 4; i++) await menu(page, "next");
  await menu(page, "join");
  expect(await opened(page)).toEqual(["https://meet.example.com/today"]);
});

// got: [] and the toast "No upcoming meeting with a link"
test("join: a month back in the grid, it's still today's meeting", async ({ page }) => {
  await open(page, [
    ev("today", "Team standup", "2026-10-14T10:00:00-04:00", "2026-10-14T10:30:00-04:00", { conference_url: "https://meet.example.com/today" }),
  ]);
  for (let i = 0; i < 4; i++) await menu(page, "prev");
  await menu(page, "join");
  expect(await opened(page)).toEqual(["https://meet.example.com/today"]);
});

// ---- [P3] Settings › account page after Disconnect ----

// got: the page still reads "Connected" with Sync now / Disconnect…, while
// the sidebar beside it already offers "Add calendar account"
test("settings: disconnecting leaves the account page", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  await settings(page).getByRole("tab", { name: /Google|@/ }).click();
  await settings(page).getByRole("button", { name: "Disconnect…" }).click();
  await settings(page).getByRole("button", { name: "Disconnect this account" }).click();
  await expect(settings(page).getByRole("button", { name: "Add calendar account" })).toBeVisible();
  await expect(settings(page).locator(".set-content")).not.toContainText("Connected");
  await expect(settings(page).getByRole("button", { name: "Sync now" })).toHaveCount(0);
});

// ---- [P3] ⌘+ as typed on a Mac keyboard (⇧⌘=) ----

// got: hour-px stays 48 (only the unshifted ⌘= zooms)
test("keys: ⌘+ typed with Shift zooms the hours in", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+Equal"); // key "+", shiftKey true
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem("hour-px") ?? 48))).toBe(60);
});

// ---- [P3] segmented controls ignore arrow keys ----

// got: focus stays on "System" and the theme stays System
test("settings: arrow keys move a segmented control's choice", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  const group = settings(page).getByRole("radiogroup", { name: "Theme" });
  await group.getByRole("radio", { name: "System" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: "Light" })).toBeFocused();
  await expect(group.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
});
