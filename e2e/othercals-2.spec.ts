// Other calendars and invitations: found by the 2026-10-21 run 5 bug-finder
// (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";
import { currentEvent } from "../src/lib/nudge";
import type { Calendar, CalendarEvent } from "../src/lib/types";

const NOW = "2026-10-14T09:00:00"; // a Wednesday
const ME = "me@example.edu";
const cal = (id: string, summary: string, access_role: string, is_primary = false): Calendar => ({
  id, summary, color: "#4986e7", is_primary, hidden: false, access_role,
});
const CALS = [
  cal(ME, "Personal", "owner", true),
  cal("lr", "Learning and Research", "owner"),
  cal("ann@example.edu", "Ann", "reader"), // a guest's calendar, shared with you read-only
  cal("school", "School", "reader"),
];
function ev(id: string, calendar_id: string, summary: string, d: number, h0: number, h1: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const at = (h: number) => new Date(2026, 9, d, h).toISOString();
  return {
    id, calendar_id, etag: null, summary, description: null, location: null,
    start: at(h0), end: at(h1), all_day: false, timezone: null, status: "confirmed",
    recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
    ...extra,
  };
}
async function open(page: Page, events: CalendarEvent[]) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: CALS, events });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 6 * 48));
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const stored = (page: Page) =>
  page.evaluate(async () => (await (window as any).__mockBackend.listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")));

async function copyLectureToPersonal(page: Page) {
  await page.locator('.chip-timed[data-ek="school/lec"]').click({ button: "right" });
  await page.getByTestId("ctx-copy-to").click();
  await page.getByTestId("ctx-menu").getByTestId("copy-target").filter({ hasText: "Personal" }).click();
  await expect(page.locator(`.chip-timed[data-ek^="${ME}/"]`, { hasText: "Lecture" })).toHaveCount(1);
}

// Your own meeting, as Google stores it on your calendar and (same event id)
// on a guest's calendar that you subscribe to read-only.
const conf = { conferenceId: "abc", entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc" }], conferenceSolution: { key: { type: "hangoutsMeet" } } };
const meeting = (calendar_id: string, self: string) => ev("sync1", calendar_id, "Team sync", 14, 13, 14, {
  conference_url: "https://meet.google.com/abc",
  raw: {
    organizer: { email: ME, ...(self === ME ? { self: true } : {}) },
    conferenceData: conf,
    attendees: [
      { email: ME, organizer: true, responseStatus: "accepted", ...(self === ME ? { self: true } : {}) },
      { email: "ann@example.edu", responseStatus: "accepted", ...(self !== ME ? { self: true } : {}) },
    ],
  },
});

// [P2] got: pasted event has attendees [] and conference_url null (the move
// dropped Ann and the Meet room). Without Ann's calendar the same steps keep both.
test("w2a: ⌘X ⌘V of your own meeting keeps its guests and Meet link when a guest's calendar is shown", async ({ page }) => {
  await open(page, [meeting(ME, ME), meeting("ann@example.edu", "ann@example.edu")]);
  const mine = page.locator(`.chip-timed[data-ek="${ME}/sync1"]`);
  await mine.click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect(mine).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await stored(page)).filter((e: any) => e.calendar_id === ME && e.summary === "Team sync").length).toBe(1);
  const pasted = (await stored(page)).find((e: any) => e.calendar_id === ME && e.summary === "Team sync");
  expect(pasted.raw.attendees.map((a: any) => a.email)).toContain("ann@example.edu"); // got: []
  expect(pasted.conference_url).toBe("https://meet.google.com/abc"); // got: null
});

// [P3] got: the School "Lecture" comes back beside your copy (count 1) after
// the copy is retitled and filed in another of your calendars.
test("w2a: a copy retitled and moved to another of your calendars still stands for its original", async ({ page }) => {
  await open(page, [ev("lec", "school", "Lecture", 14, 13, 14)]);
  const orig = page.locator('.chip-timed[data-ek="school/lec"]');
  await copyLectureToPersonal(page);
  const panel = page.getByTestId("event-panel");
  await expect(panel.getByTestId("panel-cal-trigger")).toContainText("Personal");
  await panel.locator(".panel-title").fill("CS 101 lecture");
  await panel.getByTestId("panel-cal-trigger").click();
  await page.locator(".panel-cal-option", { hasText: "Learning and Research" }).click();
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(page.locator('.chip-timed[data-ek^="lr/"]', { hasText: "CS 101 lecture" })).toHaveCount(1);
  await expect(orig).toHaveCount(0); // got: 1
});

// [P3] got: "talk" (the declined invitation) as the event you're in.
test("w2a: answering the hourly nudge doesn't open a declined invitation", () => {
  process.env.TZ = "America/New_York";
  const cals = [cal(ME, "Personal", "owner", true)];
  const deep = ev("deep", ME, "Deep work", 14, 9, 12);
  const declined = ev("talk", ME, "Seminar talk", 14, 10, 11, {
    raw: {
      organizer: { email: "prof@x.edu" },
      attendees: [{ email: ME, self: true, responseStatus: "declined" }, { email: "prof@x.edu", organizer: true, responseStatus: "accepted" }],
    },
  });
  expect(currentEvent([deep, declined], cals, new Date(2026, 9, 14, 10, 30))?.id).toBe("deep"); // got: "talk"
});

// [P3] got: two "Lecture" hits for one class (the copy and the original it
// stands for; the School hit opens an event the grid no longer shows).
test("w2a: ⌘K search shows a copied original once, as the copy", async ({ page }) => {
  await open(page, [ev("lec", "school", "Lecture", 14, 13, 14)]);
  await copyLectureToPersonal(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk input").fill("Lect");
  const hits = page.locator(".cmdk [cmdk-item]", { hasText: "Lecture" });
  await expect(hits.first()).toBeVisible();
  await page.waitForTimeout(400); // (the search is debounced)
  await expect(hits).toHaveCount(1); // got: 2
});
