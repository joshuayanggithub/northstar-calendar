// Events on the "Other calendars" (someone else's, shown read-only: a school
// account, holidays, seminar feeds). They are there to look at and copy into
// one of your calendars; only the copy is yours. So they never ask to be
// reconciled, score nothing, can't be starred, and "Copy to my calendar"
// asks which of your calendars the copy goes in (App copyTo, CopyTargets).
// Like an inbox: once copied, the copy stands for the original, which steps
// aside (lib/copies.ts) until the copy is gone again.
import { expect, test, type Page } from "@playwright/test";
import { focusScore } from "../src/lib/insights";
import type { Calendar, CalendarEvent } from "../src/lib/types";

const NOW = "2026-10-14T09:00:00"; // a Wednesday; "yesterday" is Tue Oct 13

const cal = (id: string, summary: string, access_role: string, is_primary = false): Calendar => ({
  id, summary, color: "#4986e7", is_primary, hidden: false, access_role,
});
const CALS = [
  cal("p", "Personal", "owner", true),
  cal("lr", "Learning and Research", "owner"),
  cal("school", "School", "reader"),
];

function ev(id: string, calendar_id: string, summary: string, d: number, h0: number, h1: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const at = (h: number) => new Date(2026, 9, d, h).toISOString();
  return {
    id, calendar_id, etag: null, summary, description: null, location: "Room 101",
    start: at(h0), end: at(h1), all_day: false, timezone: null, status: "confirmed",
    recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
    ...extra,
  };
}

async function open(page: Page, lecture: Partial<CalendarEvent> = {}) {
  const fixture = {
    calendars: CALS,
    events: [
      ev("lec_1", "school", "Lecture", 13, 10, 11, {
        recurring_event_id: "lec",
        ...lecture,
        raw: { masterRecurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"], ...(lecture.raw ?? {}) },
      }),
      ev("gym", "p", "Gym", 13, 7, 8),
    ],
  };
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture);
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 6 * 48));
}

const chips = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t });
/** every "Lecture" in the (mock) store, shown or not */
const lectures = (page: Page) =>
  page.evaluate(async () => {
    const be = (window as unknown as { __mockBackend: { listEvents(a: string, b: string): Promise<CalendarEvent[]> } }).__mockBackend;
    return (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).filter((e) => e.summary === "Lecture");
  });
const lecture = (page: Page) => page.locator('.chip-timed[data-ek="school/lec_1"]');

test("other calendars: never asked to be reconciled", async ({ page }) => {
  await open(page);
  // yesterday's sweep counts only your own event
  await expect(page.getByTestId("sweep-banner")).toContainText("1 event to review");
  await expect(chips(page, "Gym")).toHaveClass(/unsettled/);
  await expect(lecture(page)).not.toHaveClass(/unsettled/);
  await expect(lecture(page)).toHaveClass(/readonly/);
  await lecture(page).hover();
  await expect(lecture(page).getByTestId("recon-yes")).toHaveCount(0);

  // the right-click menu has nothing to confirm or star, just the copy
  await lecture(page).click({ button: "right" });
  const menu = page.getByTestId("ctx-menu");
  await expect(menu).toContainText("Copy to my calendar");
  await expect(menu).not.toContainText("Happened");
  await expect(menu).not.toContainText("Star as goal work");
  await expect(menu).not.toContainText("Delete");
  await page.keyboard.press("Escape");

  // the panel: no review buttons, no goal link, a copy button instead
  await lecture(page).click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.getByTestId("panel-readonly")).toContainText("School");
  await expect(panel.getByTestId("panel-recon")).toHaveCount(0);
  await expect(panel.getByTestId("goal-link")).toHaveCount(0);
  await expect(panel.getByTestId("panel-copy")).toBeVisible();
});

test("other calendars: Copy to my calendar files the copy in the calendar you pick, and opens it", async ({ page }) => {
  await open(page);
  await lecture(page).click({ button: "right" });
  await page.getByTestId("ctx-copy-to").click();
  const targets = page.getByTestId("ctx-menu").getByTestId("copy-target");
  // your calendars only, the default first
  await expect(targets).toHaveText(["Personal", "Learning and Research"]);
  await targets.filter({ hasText: "Learning and Research" }).click();

  // the copy is there, same time, on Learning and Research, and open
  const copy = page.locator('.chip-timed[data-ek^="lr/"]', { hasText: "Lecture" });
  await expect(copy).toHaveCount(1);
  const made = await lectures(page);
  const [orig, mine] = [made.find((e) => e.calendar_id === "school")!, made.find((e) => e.calendar_id === "lr")!];
  expect(new Date(mine.start).getTime()).toBe(new Date(orig.start).getTime());
  expect(new Date(mine.end).getTime()).toBe(new Date(orig.end).getTime());
  expect(mine.location).toBe("Room 101");
  expect(mine.recurrence ?? null).toBeNull(); // this occurrence only
  const panel = page.getByTestId("event-panel");
  await expect(panel.getByTestId("panel-readonly")).toHaveCount(0);
  await expect(panel.getByTestId("panel-cal-trigger")).toContainText("Learning and Research");
  await expect(page.getByTestId("toast")).toContainText("Copied “Lecture” to Learning and Research");
  // ... and the copy is yours: it asks to be reconciled
  await expect(copy).toHaveClass(/unsettled/);
  // (the morning banner waits until the editor closes)
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sweep-banner")).toContainText("2 events to review");

  // the copy stands for the original, which steps aside (no C-shape of an
  // event around its own copy); it is still there, untouched
  await expect(lecture(page)).toHaveCount(0);
  await expect(copy).not.toHaveClass(/chip-cfull/);
  expect((await lectures(page)).some((e) => e.calendar_id === "school")).toBe(true);

  // one undo takes the copy back, and the original returns
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(copy).toHaveCount(0);
  await expect(lecture(page)).toHaveCount(1);
});

test("other calendars: the panel copies one occurrence or the whole series", async ({ page }) => {
  await open(page);
  await lecture(page).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-copy").click();
  await panel.getByTestId("copy-series").check();
  await panel.getByTestId("copy-target").filter({ hasText: "Personal" }).click();
  await expect(page.getByTestId("toast")).toContainText("(every occurrence) to Personal");
  // what was created: one event carrying the series' rule
  const made = (await lectures(page)).filter((e) => e.calendar_id === "p");
  expect(made).toHaveLength(1);
  expect(made[0].recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"]);
});

test("other calendars: ⌘C ⌘V of someone else's event pastes into your calendar", async ({ page }) => {
  await open(page);
  await lecture(page).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator('.chip-timed[data-ek^="p/"]', { hasText: "Lecture" })).toHaveCount(1);
  await expect(page.getByTestId("toast")).not.toContainText("read-only");
});

test("other calendars: score nothing (a deep block on someone else's calendar isn't yours)", () => {
  process.env.TZ = "America/New_York";
  const theirs = cal("theirs", "Homework", "reader");
  const mine = cal("mine", "Homework", "owner");
  const block = (c: Calendar) => ev("b", c.id, "Problem set", 13, 9, 12);
  const score = (events: CalendarEvent[], calendars: Calendar[]) =>
    focusScore({
      day: new Date(2026, 9, 13),
      now: new Date(2026, 9, 14, 9),
      events,
      calendars,
      recon: () => "done",
      reconSince: null,
    });
  const none = score([], [theirs]);
  expect(score([block(theirs)], [theirs]).score).toBe(none.score);
  // the same block in your own Homework calendar does count
  expect(score([block(mine)], [mine]).score).toBeGreaterThan(none.score);
});

// ---- found by the 2026-10-18 bug-finder pass (run 2)

async function copyToPersonal(page: Page) {
  await lecture(page).click({ button: "right" });
  await page.getByTestId("ctx-copy-to").click();
  await page.getByTestId("ctx-menu").getByTestId("copy-target").filter({ hasText: "Personal" }).click();
  await expect(page.locator('.chip-timed[data-ek^="p/"]', { hasText: "Lecture" })).toHaveCount(1);
}
const copyChip = (page: Page) => page.locator('.chip-timed[data-ek^="p/"]', { hasText: "Lecture" });

test("other calendars: an original moved by its owner after copying comes back", async ({ page }) => {
  await open(page);
  await copyToPersonal(page);
  await page.keyboard.press("Escape");
  await expect(lecture(page)).toHaveCount(0);
  await page.evaluate(async () => {
    const be = (window as any).__mockBackend;
    const [o] = (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).filter((e: any) => e.id === "lec_1");
    await be.updateEvent("lec_1", { ...o, start: new Date(2026, 9, 13, 14).toISOString(), end: new Date(2026, 9, 13, 15).toISOString() }, "school");
  });
  await expect(copyChip(page)).toHaveCount(1);
  await expect(lecture(page)).toHaveCount(1);
});

test("other calendars: undoing a copy works after the copy was deleted and restored", async ({ page }) => {
  await open(page);
  await copyToPersonal(page);
  await page.getByTestId("event-panel").locator(".panel-kind").click();
  await page.keyboard.press("Delete");
  await expect(lecture(page)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(copyChip(page)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(copyChip(page)).toHaveCount(0);
  await expect(lecture(page)).toHaveCount(1);
});

test("other calendars: hiding the calendar holding a copy brings the original back", async ({ page }) => {
  await open(page);
  await copyToPersonal(page);
  await page.keyboard.press("Escape");
  await page.evaluate(async () => (window as any).__mockBackend.setCalendarHidden("p", true));
  await expect(copyChip(page)).toHaveCount(0);
  await expect(lecture(page)).toHaveCount(1);
});

test("other calendars: a copy keeps the Meet link (Join)", async ({ page }) => {
  const conf = { conferenceId: "abc-defg-hij", entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] };
  await open(page, { conference_url: conf.entryPoints[0].uri, raw: { conferenceData: conf } });
  await copyToPersonal(page);
  await expect.poll(async () => (await lectures(page)).find((e) => e.calendar_id === "p")?.conference_url)
    .toBe("https://meet.google.com/abc-defg-hij");
});

test("other calendars: copying every occurrence repeats in the series' timezone", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    be.getSeriesMaster = async () => ({
      id: "lec", summary: "Lecture", recurrence: ["RRULE:FREQ=WEEKLY"],
      start: { dateTime: "2026-09-03T10:00:00+01:00", timeZone: "Europe/London" },
      end: { dateTime: "2026-09-03T11:00:00+01:00", timeZone: "Europe/London" },
    });
    const create = be.createEvent.bind(be);
    be.createEvent = async (i: any) => { (window as any).__copyInput = i; return create(i); };
  });
  await lecture(page).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-copy").click();
  await panel.getByTestId("copy-series").check();
  await panel.getByTestId("copy-target").filter({ hasText: "Personal" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copyInput?.time_zone)).toBe("Europe/London");
});
