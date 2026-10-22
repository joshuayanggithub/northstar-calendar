// Invitations: guests with their answers in the panel, your own Yes/No/Maybe,
// and invitation chips that look different until you accept (Google's look).
import { expect, test, type Page } from "@playwright/test";

const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const evt = (id: string, summary: string, start: string, end: string, raw: Record<string, unknown>) => ({
  id, calendar_id: "primary", etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw,
});
const invite = (me: string) => ({
  organizer: { email: "prof@example.edu" },
  attendees: [
    { email: "ta1@example.edu", responseStatus: "accepted" },
    { email: "prof@example.edu", organizer: true, responseStatus: "accepted", displayName: "Prof Example" },
    { email: "ta2@example.edu", responseStatus: "declined" },
    { email: "me@example.edu", self: true, responseStatus: me },
    { email: "ta3@example.edu", responseStatus: "needsAction" },
    { email: "room-4401@resource.example", resource: true, responseStatus: "accepted" },
  ],
});
const EVENTS = [
  evt("staff", "Course staff", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00", invite("needsAction")),
  evt("talk", "Seminar talk", "2026-10-15T10:00:00-04:00", "2026-10-15T11:00:00-04:00", invite("tentative")),
  evt("party", "Lab party", "2026-10-16T10:00:00-04:00", "2026-10-16T11:00:00-04:00", invite("declined")),
  ...["2026-10-15", "2026-10-16"].map((d, i) => ({
    ...evt(`wk_${i}`, "Reading group", `${d}T14:00:00-04:00`, `${d}T15:00:00-04:00`, invite("needsAction")),
    recurring_event_id: "wk",
    raw: { ...invite("needsAction"), masterRecurrence: ["RRULE:FREQ=DAILY;COUNT=2"], originalStartTime: { dateTime: `${d}T14:00:00-04:00` } },
  })),
  evt("mine", "My 1:1", "2026-10-13T10:00:00-04:00", "2026-10-13T11:00:00-04:00", {
    organizer: { email: "me@example.edu", self: true },
    attendees: [
      { email: "me@example.edu", self: true, organizer: true, responseStatus: "accepted" },
      { email: "ann@example.edu", responseStatus: "tentative" },
    ],
  }),
];

async function open(page: Page) {
  await page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, { calendars: [PRIMARY], events: EVENTS });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T08:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t }).first();
const panel = (page: Page) => page.getByTestId("event-panel");
const attendees = (page: Page, id: string) => page.evaluate(async (id) => (await (window as any).__mockBackend
  .listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).find((e: any) => e.id === id).raw.attendees, id);

test("rsvp: the panel lists the guests with their answers and a tally, rooms left out", async ({ page }) => {
  await open(page);
  await chip(page, "Course staff").click({ position: { x: 6, y: 6 } });
  const guests = panel(page).getByTestId("guests");
  await expect(guests.locator(".panel-guests-count")).toHaveText("5 guests");
  await expect(guests.getByTestId("guests-tally")).toHaveText("2 yes, 1 no, 2 awaiting");
  const rows = guests.getByTestId("guest-row");
  await expect(rows).toHaveCount(5);
  // organizer first (by name, its address under it), then you
  await expect(rows.nth(0).locator(".guest-name")).toHaveText("Prof Example");
  await expect(rows.nth(0).locator(".guest-sub")).toHaveText("Organizer · prof@example.edu");
  await expect(rows.nth(1).locator(".guest-sub")).toHaveText("You");
  expect(await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.rsvp)))
    .toEqual(["accepted", "needsAction", "accepted", "declined", "needsAction"]);
  await expect(rows.filter({ hasText: "ta2@example.edu" }).locator(".guest-badge")).toHaveText("✕");
  await expect(rows.filter({ hasText: "ta1@example.edu" }).locator(".guest-badge")).toHaveText("✓");
  // someone else's meeting: no editing its guest list
  await expect(panel(page).locator(".panel-attendee-input")).toHaveCount(0);
  await expect(panel(page).locator(".guest-remove")).toHaveCount(0);
});

test("rsvp: invitations look different on the grid until accepted", async ({ page }) => {
  await open(page);
  await expect(chip(page, "Course staff")).toHaveClass(/invite-pending/);
  await expect(chip(page, "Seminar talk")).toHaveClass(/invite-maybe/);
  await expect(chip(page, "Lab party")).toHaveClass(/invite-declined/);
  await expect(chip(page, "Lab party").locator(".chip-title").first()).toHaveCSS("text-decoration-line", "line-through");
  await expect(chip(page, "My 1:1")).not.toHaveClass(/invite-/);
  // month view too
  await page.keyboard.press("m");
  await expect(page.locator(".mchip", { hasText: "Course staff" })).toHaveClass(/invite-pending/);
});

test("rsvp: Yes answers the invitation (only your own answer changes) and Cmd+Z takes it back", async ({ page }) => {
  await open(page);
  const before = await attendees(page, "staff");
  await chip(page, "Course staff").click({ position: { x: 6, y: 6 } });
  const bar = panel(page).getByTestId("rsvp");
  await expect(bar.getByRole("button", { pressed: true })).toHaveCount(0);
  await bar.getByRole("button", { name: "Yes" }).click();
  await expect(bar.getByRole("button", { name: "Yes" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("toast")).toContainText("Replied Yes");
  const after = await attendees(page, "staff");
  expect(after).toEqual(before.map((a: any) => (a.self ? { ...a, responseStatus: "accepted" } : a)));
  await expect(panel(page).getByTestId("guests-tally")).toHaveText("3 yes, 1 no, 1 awaiting");
  await expect(chip(page, "Course staff")).not.toHaveClass(/invite-/);

  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await attendees(page, "staff")).find((a: any) => a.self).responseStatus).toBe("needsAction");
  await expect(chip(page, "Course staff")).toHaveClass(/invite-pending/);
});

test("rsvp: No and Maybe answer too; your own meeting has no Going? bar", async ({ page }) => {
  await open(page);
  await chip(page, "Seminar talk").click({ position: { x: 6, y: 6 } });
  const bar = panel(page).getByTestId("rsvp");
  await expect(bar.getByRole("button", { name: "Maybe" })).toHaveAttribute("aria-pressed", "true");
  await bar.getByRole("button", { name: "No" }).click();
  await expect.poll(async () => (await attendees(page, "talk")).find((a: any) => a.self).responseStatus).toBe("declined");
  await expect(chip(page, "Seminar talk")).toHaveClass(/invite-declined/);

  await chip(page, "My 1:1").click({ position: { x: 6, y: 6 } });
  await expect(panel(page).locator(".panel-title")).toHaveValue("My 1:1");
  await expect(panel(page).getByTestId("rsvp")).toHaveCount(0);
  await expect(panel(page).getByTestId("guests-tally")).toHaveText("1 yes, 1 maybe");
  // you organize it: guests can still be edited
  await expect(panel(page).locator(".panel-attendee-input")).toHaveCount(1);
});

const myAnswers = (page: Page, summary: string) => page.evaluate(async (summary) => (await (window as any).__mockBackend
  .listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"))
  .filter((e: any) => e.summary === summary)
  .sort((a: any, b: any) => a.start.localeCompare(b.start))
  .map((e: any) => e.raw.attendees.find((a: any) => a.self).responseStatus), summary);

test("rsvp: a recurring invitation asks this one or every one; All events answers the series", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    const orig = be.updateSeriesMaster.bind(be);
    be.updateSeriesMaster = (...a: any[]) => { (window as any).__seriesPatch = a[2]; return orig(...a); };
  });
  await chip(page, "Reading group").click({ position: { x: 6, y: 6 } });
  await panel(page).getByTestId("rsvp").getByRole("button", { name: "Yes" }).click();
  const dialog = page.getByTestId("scope-dialog");
  await expect(dialog.locator("h3")).toHaveText("Reply to recurring event");
  await expect(dialog.getByTestId("scope-following")).toHaveCount(0); // a guest can't split the series
  await dialog.getByTestId("scope-all").click();
  await expect.poll(() => myAnswers(page, "Reading group")).toEqual(["accepted", "accepted"]);
  // only your answer changes on the series' guest list
  const sent = await page.evaluate(() => (window as any).__seriesPatch);
  expect(Object.keys(sent)).toEqual(["attendees"]);
  expect(sent.attendees.map((a: any) => a.responseStatus)).toEqual(["accepted", "accepted", "declined", "accepted", "needsAction", "accepted"]);
  await expect(chip(page, "Reading group")).not.toHaveClass(/invite-/);

  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => myAnswers(page, "Reading group")).toEqual(["needsAction", "needsAction"]);
});

test("rsvp: This event answers just that occurrence", async ({ page }) => {
  await open(page);
  await chip(page, "Reading group").click({ position: { x: 6, y: 6 } });
  await panel(page).getByTestId("rsvp").getByRole("button", { name: "No" }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-this").click();
  await expect.poll(() => myAnswers(page, "Reading group")).toEqual(["declined", "needsAction"]);
});
