// Quick create phrasings: found by the 2026-10-19 run 4 parser fuzz (each failed
// before its fix).
// Each case types into the C dialog, checks the preview, presses Enter and
// checks the stored row.
import { expect, test, type Page } from "@playwright/test";
import { parseQuickCreate } from "../src/lib/nlp";

const fixture = { calendars: [{ id: "p", summary: "Me", color: "#9fe1e7", is_primary: true, hidden: false, access_role: "owner" }], events: [] };
async function open(page: Page, nowIso: string) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await page.goto(`/?now=${encodeURIComponent(nowIso)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}
const rows = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"))
    .map((e: any) => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, all_day: e.all_day, recurrence: e.recurrence })));
/** type `text` into quick create, press Enter; the row it created */
async function quick(page: Page, text: string) {
  const before = new Set((await rows(page)).map((r: any) => r.id));
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-create")).toHaveCount(0);
  return (await rows(page)).find((r: any) => !before.has(r.id))!;
}
// "Oct 20, 2026, 7:00 AM" in the suite's pinned zone; all-day rows are dates
const at = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const shape = (r: any) => r.all_day ? [r.summary, r.start, r.end, true] : [r.summary, at(r.start), at(r.end), false];

type Case = [text: string, summary: string, start: string, end: string, allDay?: boolean];
function cases(name: string, nowIso: string, list: Case[]) {
  test(`quick create: ${name}`, async ({ page }) => {
    await open(page, nowIso);
    const got: unknown[] = [], want: unknown[] = [];
    for (const [text, summary, start, end, allDay = false] of list) {
      got.push([text, ...shape(await quick(page, text))]);
      want.push([text, summary, start, end, allDay]);
    }
    expect(got).toEqual(want);
  });
}

// 1. date first, then the title, then the time
cases("a day typed before the title keeps the time typed after it", "2026-10-19T14:00:00", [
  ["tomorrow gym 7am", "gym", "Oct 20, 2026, 7:00 AM", "Oct 20, 2026, 8:00 AM"],
  ["monday standup 9am", "standup", "Oct 26, 2026, 9:00 AM", "Oct 26, 2026, 10:00 AM"],
  ["tomorrow dentist at 3", "dentist", "Oct 20, 2026, 3:00 PM", "Oct 20, 2026, 4:00 PM"],
  ["thu office hours 3-4pm", "office hours", "Oct 22, 2026, 3:00 PM", "Oct 22, 2026, 4:00 PM"],
]);
test("quick create: preview of 'tomorrow gym 7am' shows the time", async ({ page }) => {
  await open(page, "2026-10-19T14:00:00");
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill("tomorrow gym 7am");
  await expect(page.locator(".qc-preview")).toHaveText("gym · Tue, Oct 20 · 7:00 AM – 8:00 AM");
});

// 2. a range across noon with am/pm only on the end
cases("'11-1pm' and '10-12pm' start in the morning", "2026-10-19T09:00:00", [
  ["class 11-1pm", "class", "Oct 19, 2026, 11:00 AM", "Oct 19, 2026, 1:00 PM"],
  ["talk 10-12pm", "talk", "Oct 19, 2026, 10:00 AM", "Oct 19, 2026, 12:00 PM"],
  ["brunch sat 11-1pm", "brunch", "Oct 24, 2026, 11:00 AM", "Oct 24, 2026, 1:00 PM"],
  ["lab 10:30-12:30pm tomorrow", "lab", "Oct 20, 2026, 10:30 AM", "Oct 20, 2026, 12:30 PM"],
]);

// 3. "tonight" / "morning" settle a bare hour
cases("'tonight 8' is the evening, 'morning at 7' the morning", "2026-10-19T14:00:00", [
  ["movie tonight 8", "movie", "Oct 19, 2026, 8:00 PM", "Oct 19, 2026, 9:00 PM"],
  ["party tonight at 9", "party", "Oct 19, 2026, 9:00 PM", "Oct 19, 2026, 10:00 PM"],
  ["study tonight 9-11", "study", "Oct 19, 2026, 9:00 PM", "Oct 19, 2026, 11:00 PM"],
  ["gym tomorrow morning at 7", "gym", "Oct 20, 2026, 7:00 AM", "Oct 20, 2026, 8:00 AM"],
]);

// 4. a number right before "oct 21" is the title's, not the day (with 21 as the year)
cases("'Lab 2 oct 21', '1:1 oct 21', 'quiz 3 nov 12' keep the number and land this year", "2026-10-19T14:00:00", [
  ["Lab 2 oct 21 3pm", "Lab 2", "Oct 21, 2026, 3:00 PM", "Oct 21, 2026, 4:00 PM"],
  ["1:1 oct 21 3pm", "1:1", "Oct 21, 2026, 3:00 PM", "Oct 21, 2026, 4:00 PM"],
  ["quiz 3 nov 12", "quiz 3", "2026-11-12", "2026-11-13", true],
  ["meeting 17:30 oct 21", "meeting", "Oct 21, 2026, 5:30 PM", "Oct 21, 2026, 6:30 PM"],
]);

// 5. noon as one end of a range
cases("'noon-1' and '10-noon' are lunchtime ranges", "2026-10-19T09:00:00", [
  ["lunch noon-1", "lunch", "Oct 19, 2026, 12:00 PM", "Oct 19, 2026, 1:00 PM"],
  ["talk 10-noon", "talk", "Oct 19, 2026, 10:00 AM", "Oct 19, 2026, 12:00 PM"],
]);

// 6. "tues"
cases("'tues' is Tuesday", "2026-10-19T14:00:00", [
  ["dentist tues 3pm", "dentist", "Oct 20, 2026, 3:00 PM", "Oct 20, 2026, 4:00 PM"],
]);

// 7. an hour range followed by a date that isn't a bare day word
cases("an hour range before 'nov 12', 'oct 22' or 'on friday' is a time", "2026-10-19T14:00:00", [
  ["exam 1-4 nov 12", "exam", "Nov 12, 2026, 1:00 PM", "Nov 12, 2026, 4:00 PM"],
  ["dentist 3-4 oct 22", "dentist", "Oct 22, 2026, 3:00 PM", "Oct 22, 2026, 4:00 PM"],
  ["meeting 2-3 on friday", "meeting", "Oct 23, 2026, 2:00 PM", "Oct 23, 2026, 3:00 PM"],
]);

// 8. both ends in the same hour
cases("'9-9:15' and '4:30-4:45' are 15 minutes", "2026-10-19T08:00:00", [
  ["standup 9-9:15", "standup", "Oct 19, 2026, 9:00 AM", "Oct 19, 2026, 9:15 AM"],
  ["ta 4:30-4:45", "ta", "Oct 19, 2026, 4:30 PM", "Oct 19, 2026, 4:45 PM"],
]);

// 9. overnight on a named day
test("quick create: 'party fri 10pm-1am' ends Saturday and shows on the grid", async ({ page }) => {
  await open(page, "2026-10-19T14:00:00");
  const r = await quick(page, "party fri 10pm-1am");
  expect(shape(r)).toEqual(["party", "Oct 23, 2026, 10:00 PM", "Oct 24, 2026, 1:00 AM", false]);
  await expect(page.locator(".chip", { hasText: "party" }).first()).toBeVisible();
});
cases("'9pm-12' ends at midnight", "2026-10-19T14:00:00", [
  ["party 9pm-12", "party", "Oct 19, 2026, 9:00 PM", "Oct 20, 2026, 12:00 AM"],
]);

// 10. "from 3 to 5"
cases("'from 3 to 5' is the afternoon", "2026-10-19T09:00:00", [
  ["sync from 3 to 5", "sync", "Oct 19, 2026, 3:00 PM", "Oct 19, 2026, 5:00 PM"],
]);

// 11. a named day's midnight
cases("'due fri midnight' is the end of Friday; 'tonight at midnight' isn't noon", "2026-10-19T14:00:00", [
  ["HW4 due fri midnight", "HW4 due", "Oct 24, 2026, 12:00 AM", "Oct 24, 2026, 1:00 AM"],
  ["HW due tonight at midnight", "HW due", "Oct 20, 2026, 12:00 AM", "Oct 20, 2026, 1:00 AM"],
]);

// 12. repeat words
test("quick create: 'weekdays', 'tue/thu', 'thursdays', 'every other friday' repeat", async ({ page }) => {
  await open(page, "2026-10-19T14:00:00");
  const got = [];
  for (const t of ["standup weekdays 9am", "class tue/thu 1:30-2:50", "office hours thursdays 3-4pm", "seminar every other friday 4pm"]) {
    const r = await quick(page, t);
    got.push([r.summary, r.all_day, r.recurrence]);
  }
  expect(got).toEqual([
    ["standup", false, ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]],
    ["class", false, ["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"]],
    ["office hours", false, ["RRULE:FREQ=WEEKLY;BYDAY=TH"]],
    ["seminar", false, ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"]],
  ]);
});

// 13. a day/month word (or "3D") in the title doesn't take over the date
cases("'Wed planning thu 9am' and '3D printing wed 3-5' keep their titles and times", "2026-10-19T14:00:00", [
  ["Wed planning thu 9am", "Wed planning", "Oct 22, 2026, 9:00 AM", "Oct 22, 2026, 10:00 AM"],
  ["3D printing wed 3-5", "3D printing", "Oct 21, 2026, 3:00 PM", "Oct 21, 2026, 5:00 PM"],
]);

// 14. evening plans / breakfast
cases("'dinner at 8' is tonight, 'breakfast tomorrow 7' is the morning", "2026-10-19T14:00:00", [
  ["dinner at 8", "dinner", "Oct 19, 2026, 8:00 PM", "Oct 19, 2026, 9:00 PM"],
  ["breakfast tomorrow 7", "breakfast", "Oct 20, 2026, 7:00 AM", "Oct 20, 2026, 8:00 AM"],
]);

// 15. a typed length
cases("'for 2h' sets the length", "2026-10-19T09:00:00", [
  ["study 2pm for 2h", "study", "Oct 19, 2026, 2:00 PM", "Oct 19, 2026, 4:00 PM"],
]);

// 16. "the 21st"
cases("'on the 21st' is a date", "2026-10-19T14:00:00", [
  ["exam on the 21st 1-4pm", "exam", "Oct 21, 2026, 1:00 PM", "Oct 21, 2026, 4:00 PM"],
]);

// Regressions of 5178e564 found by the run 4 review (each failed before its fix).

const refR = new Date(2026, 9, 19, 9, 0); // Mon Oct 19 2026, 9 AM
const atR = (d: Date) => d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// [P2] Keep a range that ends at midnight starting at its start time
test("quick create: a range ending at midnight keeps its start", () => {
  for (const [text, start] of [
    ["dinner 9pm-midnight", "Mon, Oct 19, 9:00 PM"],
    ["dinner 9pm until midnight", "Mon, Oct 19, 9:00 PM"],
    ["work 6pm to midnight", "Mon, Oct 19, 6:00 PM"],
  ]) {
    const r = parseQuickCreate(text, refR)!;
    // got: "Tue, Oct 20, 12:00 AM" -> "Tue, Oct 20, 1:00 AM" for all three (a 1h event at midnight)
    expect([text, atR(r.start), atR(r.end)]).toEqual([text, start, "Tue, Oct 20, 12:00 AM"]);
  }
});

// [P3] Leave an ordinal that names a thing ("the 2nd draft", "the 3rd floor") alone
test("quick create: 'the 2nd draft' / 'the 2nd floor' are not dates", () => {
  const a = parseQuickCreate("review the 2nd draft friday", refR)!;
  // got: { title: "review draft friday", start: "Mon, Nov 2" } (all-day)
  expect([a.title, a.start.toDateString()]).toEqual(["review the 2nd draft", new Date(2026, 9, 23).toDateString()]);
  const b = parseQuickCreate("meeting on the 2nd floor friday 10am", refR)!;
  // got: title "meeting Nov 2 floor"
  expect(b.title).toBe("meeting on the 2nd floor");
});

// [P3] Don't read "every other month" / "every 2 hours" as every two weeks
test("quick create: every other month / every 2 hours is not biweekly", () => {
  for (const text of ["book club every other month", "dinner club every 2 months", "review every other year", "take meds every 2 hours"]) {
    const r = parseQuickCreate(text, refR)!;
    // got: ["RRULE:FREQ=WEEKLY;INTERVAL=2"] for all four (title e.g. "book club month")
    expect([text, (r.recurrence ?? []).join(";")]).not.toEqual([text, "RRULE:FREQ=WEEKLY;INTERVAL=2"]);
  }
});
