// Event editor: found by the 2026-10-19 run 4 bug-finder (each failed before
// its fix).
import { expect, test, type Page } from "@playwright/test";

const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const evt = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "primary", etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
async function open(page: Page, events: unknown[], now = "2026-10-14T09:00:00") {
  await page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, { calendars: [PRIMARY], events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const chip = (page: Page, id: string) => page.locator(`[data-ek="primary/${id}"]`).first();
const panel = (page: Page) => page.getByTestId("event-panel");
const rows = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")));
const row = async (page: Page, id: string) => (await rows(page)).find((e: any) => e.id === id);
const minutes = (e: any) => (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000;

// [P2] got: the panel shows "+2d51h" and Save stores a 51h event
test("multi-day timed event: an end time picked from the list gives the duration the list shows", async ({ page }) => {
  await open(page, [evt("trip", "Road trip", "2026-10-14T09:00:00-04:00", "2026-10-16T10:00:00-04:00")]);
  await chip(page, "trip").click();
  const p = panel(page);
  await expect(p.locator(".panel-dur")).toContainText("+2d");
  await p.getByTestId("time-end").focus();
  const opt = p.locator("[data-testid=time-pop] .time-opt").filter({ has: page.locator(".time-opt-sub", { hasText: /^3h$/ }) });
  await expect(opt).toContainText("12 PM");
  await opt.dispatchEvent("pointerdown");
  await expect(p.locator(".panel-dur")).toHaveText("3h"); // got "+2d51h"
});

// [P2] got: 30 (min) after a title-only edit; the same happens on a Save with no edit at all
test("zero-length event: Save keeps it zero-length", async ({ page }) => {
  await open(page, [
    evt("zero", "Check-in opens", "2026-10-14T15:00:00-04:00", "2026-10-14T15:00:00-04:00"),
    evt("zero2", "Deadline", "2026-10-14T17:00:00-04:00", "2026-10-14T17:00:00-04:00"),
  ]);
  await chip(page, "zero").click();
  await panel(page).locator(".panel-title").fill("Check-in opens (UA 12)");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => (await row(page, "zero")).summary).toBe("Check-in opens (UA 12)");
  await chip(page, "zero2").click();
  await panel(page).getByRole("button", { name: /^Save/ }).click(); // nothing edited
  await expect(panel(page)).toHaveCount(0);
  expect([minutes(await row(page, "zero")), minutes(await row(page, "zero2"))]).toEqual([0, 0]); // got [30, 30]
});

// [P3] got: { shown: "Default reminder", reminders: { useDefault: false, overrides: [] } } (nothing was written)
test("reminders: an event with no reminders says so and can be set back to the default reminder", async ({ page }) => {
  await open(page, [evt("quiet", "Focus", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00", {
    raw: { reminders: { useDefault: false, overrides: [] } },
  })]);
  await chip(page, "quiet").click();
  const sel = panel(page).locator("select.panel-cal");
  const shown = await sel.evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent);
  await sel.selectOption({ label: "10 min before" });
  await sel.selectOption({ label: "Default reminder" });
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect(panel(page)).toHaveCount(0);
  const ev = await row(page, "quiet");
  expect({ shown, reminders: ev.raw.reminders })
    .toEqual({ shown: expect.not.stringMatching(/Default/), reminders: { useDefault: true } });
});

// [P3] got: { shown: "opaque", stored: "opaque" } (Busy)
test("new all-day event drafted in the all-day lane defaults to Free", async ({ page }) => {
  await open(page, []);
  const box = (await page.locator(".allday-cell").nth(3).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const p = panel(page);
  await expect(p.locator(".panel-kind")).toHaveText("New event");
  await expect(p.locator(".all-day-label")).toBeVisible();
  await p.locator(".panel-title").fill("Conference");
  const shown = await p.locator(".panel-inline-select").first().evaluate((s: HTMLSelectElement) => s.value);
  await p.getByRole("button", { name: /^Create/ }).click();
  await expect.poll(async () => (await rows(page)).filter((e: any) => e.summary === "Conference").length).toBe(1);
  const ev = (await rows(page)).find((e: any) => e.summary === "Conference");
  expect({ shown, stored: ev.raw.transparency }).toEqual({ shown: "transparent", stored: "transparent" });
});

// [P3] got: 3 guest rows ("Ann@Example.com" and "ann@example.com"); Save sends Ann's attendee resource twice
test("guests: re-typing an existing guest in another letter case adds no duplicate", async ({ page }) => {
  await open(page, [evt("mtg", "Sync", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00", {
    raw: { organizer: { email: "me@example.com", self: true }, attendees: [
      { email: "me@example.com", self: true, organizer: true, responseStatus: "accepted" },
      { email: "Ann@Example.com", responseStatus: "accepted" },
    ] },
  })]);
  await chip(page, "mtg").click();
  const p = panel(page);
  await expect(p.getByTestId("guest-row")).toHaveCount(2);
  await p.locator(".panel-attendee-input").fill("ann@example.com");
  await p.locator(".panel-attendee-input").press("Enter");
  await expect(p.getByTestId("guest-row")).toHaveCount(2); // got 3
});
