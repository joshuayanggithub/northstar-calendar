// Regressions in 0da32437..02cd3087 found by the run 4 third review (each failed
// before its fix).
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves } from "../src/lib/layout";
import { parseQuickCreate } from "../src/lib/nlp";

const PX = 48 / 60; // px per minute at the default zoom
const m = (h: number, min = 0) => h * 60 + min;

// ---------------------------------------------------------------------------
// [P2] layout.ts:389-391 (02cd3087): the new "crossing" test drops a C-shape's
// low title band whenever a same-depth event starts before the band's end,
// even when that event is held at the same place anyway by the enclosed
// event's own title. The enclosed event then loses its true start for nothing.
// 9-11 Deep work encloses a 9:00 standup; a 9:30-11:30 review crosses its end.

const deep = { item: "deep", startMin: m(9), endMin: m(11) };
const standup = { item: "standup", startMin: m(9), endMin: m(9, 15) };
const review = { item: "review", startMin: m(9, 30), endMin: m(11, 30) };

test("layout: a standup at a work block's top keeps its start when a meeting crosses the block", () => {
  for (const joints of [true, false]) {
    const p = packDayWithSleeves([deep, standup, review], PX, 17, joints);
    const s = p.regular.find((r) => r.item === "standup")!;
    const r = p.regular.find((x) => x.item === "review")!;
    // got: 449 (9:21) for joints true and false; 0da32437: 432 (9:00)
    expect(s.top, `standup top, joints=${joints}`).toBeCloseTo(m(9) * PX, 0);
    // the review is held below the standup's title either way (466 on both)
    expect(r.top, `review top, joints=${joints}`).toBeLessThanOrEqual(466.5);
  }
});

test("week: the 9:00 standup inside a 9-11 block sits on the 9:00 line with a 9:30 meeting crossing the block", async ({ page }) => {
  const cal = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
  const ev = (id: string, summary: string, s: string, e: string) => ({
    id, calendar_id: "p", etag: null, summary, description: null, location: null,
    start: `2026-10-14T${s}:00-04:00`, end: `2026-10-14T${e}:00-04:00`, all_day: false, timezone: null,
    status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: null,
  });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [cal],
    events: [ev("d", "Deep work", "09:00", "11:00"), ev("s", "Standup", "09:00", "09:15"), ev("r", "Design review", "09:30", "11:30")],
  });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T08:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  await page.getByTestId("week-grid").evaluate((el) => { el.scrollTop = 8 * 48; });
  const col = (await page.getByTestId("day-col-3").boundingBox())!; // Wed Oct 14
  const s = (await page.locator(".chip-timed", { hasText: "Standup" }).first().boundingBox())!;
  // got: 17px below the 9:00 line (drawn from 9:21); 0da32437: on it
  expect(Math.abs(s.y - (col.y + 9 * 48)), "standup px off the 9:00 line").toBeLessThanOrEqual(1.5);
});

// ---------------------------------------------------------------------------
// [P3] nlp.ts:196 (90726f63): the widened ordinal lookahead turns "the 2nd"
// into a date before "by <weekday>", so the weekday the user typed is dropped
// (event two weeks out) or the rewritten "Nov 2" leaks into the title.

const REF = new Date(2026, 9, 19, 14, 0); // Mon Oct 19 2026, 2 PM

test("quick create: 'the 2nd by friday' keeps the typed Friday and the user's own words", () => {
  const a = parseQuickCreate("Submit the 2nd by friday", REF)!;
  // got: Mon Nov 2 (all-day), title "Submit by friday"; 0da32437: Fri Oct 23
  expect(a.start.toDateString()).toBe(new Date(2026, 9, 23).toDateString());
  const b = parseQuickCreate("Finish the 2nd by friday 5pm", REF)!;
  // got: title "Finish Nov 2 by" (text never typed); 0da32437: "Finish the 2nd by"
  expect(b.title).not.toMatch(/Nov/);
  expect(b.start.getTime()).toBe(new Date(2026, 9, 23, 17, 0).getTime());
});
