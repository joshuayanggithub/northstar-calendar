// Settings (⌘,), Help (⌘/), the menu bar's commands, and the settings that
// change what's on screen: notes, declined invitations, deep-work calendars.
import { expect, test, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const HW = { id: "hw", summary: "Homework", color: "#e9a23b", is_primary: false, hidden: false, access_role: "owner" };
const ev = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const EVENTS = [
  ev("n", "p", "Review", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00", { description: "[DRILL] start with the hard one" }),
  ev("d", "p", "Lab party", "2026-10-15T10:00:00-04:00", "2026-10-15T11:00:00-04:00", {
    raw: { organizer: { email: "x@example.edu" }, attendees: [{ email: "me@example.edu", self: true, responseStatus: "declined" }] },
  }),
  ev("h", "hw", "Problem set", "2026-10-13T09:00:00-04:00", "2026-10-13T11:00:00-04:00"),
  ev("w", "p", "Reading", "2026-10-13T13:00:00-04:00", "2026-10-13T14:00:00-04:00"),
];

async function open(page: Page) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [P, HW], events: EVENTS });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const settings = (page: Page) => page.getByTestId("settings");
const sw = (page: Page, name: string) => settings(page).getByRole("switch", { name, exact: true });

test("settings: ⌘, opens it, the sidebar switches pages, Escape closes it", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings(page)).toBeVisible();
  await expect(settings(page).locator("h3").first()).toHaveText("Appearance");
  await settings(page).getByRole("tab", { name: "Notifications" }).click();
  await expect(settings(page).locator("h3").first()).toHaveText("Event alerts");
  await settings(page).getByRole("tab", { name: "About North Star" }).click();
  await expect(settings(page).getByTestId("settings-version")).toHaveText(/^Version \d+\.\d+\.\d+$/);
  // the calendar doesn't take keys while it's open
  await page.keyboard.press("m");
  await expect(page.getByTestId("month-grid")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
});

test("settings: the notes switch and the A key hide and show margin notes, and it sticks", async ({ page }) => {
  await open(page);
  await expect(page.locator(".margin-note")).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.locator(".margin-note")).toBeHidden();
  await expect(page.getByTestId("toast")).toContainText("Notes hidden");
  await page.reload();
  await expect(page.locator(".mock-badge")).toBeVisible();
  await expect(page.locator(".chip-timed", { hasText: "Review" })).toBeVisible();
  await expect(page.locator(".margin-note")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(sw(page, "Notes")).toHaveAttribute("aria-checked", "false");
  await sw(page, "Notes").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".margin-note")).toBeVisible();
});

test("settings: declined events can be hidden", async ({ page }) => {
  await open(page);
  await expect(page.locator(".chip-timed", { hasText: "Lab party" })).toHaveClass(/invite-declined/);
  await page.keyboard.press("ControlOrMeta+,");
  await sw(page, "Declined events").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".chip-timed", { hasText: "Lab party" })).toHaveCount(0);
  await expect(page.locator(".chip-timed", { hasText: "Review" })).toBeVisible();
});

test("settings: the deep-work calendars decide what Insights counts", async ({ page }) => {
  await open(page);
  await page.keyboard.press("i");
  await expect(page.getByTestId("ins-deepwork").locator(".ins-big")).toHaveText("2h");
  await page.keyboard.press("ControlOrMeta+,");
  await settings(page).getByRole("tab", { name: "Insights & review" }).click();
  await sw(page, "Personal counts as deep work").click();
  await sw(page, "Homework counts as deep work").click();
  await page.keyboard.press("Escape");
  // Reading (1h, Personal) counts now, Problem set (Homework) doesn't
  await expect(page.getByTestId("ins-deepwork").locator(".ins-big")).toHaveText("1h");
});

test("menu bar: commands do what their keys do; ⌘1–5 switch views; ⌘/ shows the shortcuts", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__menu("view-month"));
  await expect(page.getByTestId("month-grid")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+2");
  await expect(page.getByTestId("month-grid")).toHaveCount(0);
  await expect(page.locator(".chip-timed", { hasText: "Review" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+5");
  await expect(page.getByTestId("insights-view")).toBeVisible();
  await page.evaluate(() => (window as any).__menu("view-week"));
  await expect(page.locator(".chip-timed", { hasText: "Review" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+]");
  await expect(page.locator(".topbar, header").first()).toContainText("October 2026");
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("help")).toBeVisible();
  await expect(page.getByTestId("help").getByRole("tab", { name: "Shortcuts" })).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("help").getByRole("tab", { name: "Guide" }).click();
  await expect(page.getByTestId("help")).toContainText("Isolate a calendar");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help")).toHaveCount(0);
  await page.evaluate(() => (window as any).__menu("settings"));
  await expect(settings(page)).toBeVisible();
});

test("settings: event shading per theme changes the grid's fills, sticks, and resets", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Reading" }).first();
  const bg = () => chip.evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await bg();
  await page.keyboard.press("ControlOrMeta+,");
  await settings(page).getByRole("radio", { name: "Dark" }).last().click(); // "Adjusting: Dark"
  await settings(page).getByRole("slider", { name: "Upcoming events" }).fill("75");
  await page.keyboard.press("Escape");
  const strong = await bg();
  expect(strong).not.toBe(before);
  // the light theme keeps its own (read once its palette is painted: the
  // calendar's color for the theme lands a frame after the switch)
  const calOf = () => chip.evaluate((el) => getComputedStyle(el).getPropertyValue("--cal").trim());
  const darkCal = await calOf();
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(calOf).not.toBe(darkCal);
  const lightBg = await bg();
  await page.reload();
  await expect(page.locator(".mock-badge")).toBeVisible();
  // (a theme flip repaints the chips a frame later: each theme has its palette)
  await expect.poll(bg).toBe(lightBg);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(bg).toBe(strong); // persisted
  await page.keyboard.press("ControlOrMeta+,");
  await settings(page).getByRole("button", { name: "Reset both" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(bg).toBe(before);
});
