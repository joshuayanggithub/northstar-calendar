// Regressions in 4c8bf2fb..HEAD found by the run 4 second review (each failed
// before its fix).
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves } from "../src/lib/layout";
import { parseQuickCreate } from "../src/lib/nlp";

const PX = 48 / 60; // px per minute at the default zoom
const m = (h: number, min = 0) => h * 60 + min;
const CAL = [{ id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" }];
const ev = (o: Record<string, unknown>) => ({
  id: "x", calendar_id: "p", etag: null, summary: "X", description: null, location: null,
  start: "", end: "", all_day: false, timezone: null, status: "confirmed", recurrence: null,
  recurring_event_id: null, conference_url: null, updated: null, raw: null, ...o,
});
const timed = (id: string, summary: string, s: string, e: string) => ev({ id, summary, start: `${s}:00-04:00`, end: `${e}:00-04:00` });
async function boot(page: Page, now: string, events: unknown[], init?: () => void) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: CAL, events });
  if (init) await page.addInitScript(init);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}

// ---------------------------------------------------------------------------
// Layout (62a704d1): a short jointed event now runs past its end and pushes
// the event booked right after it down.

test("layout: the event right after a short overlapping one starts at its own time", () => {
  // 9:30-10:15 planning, a 10:00-10:30 call overlapping its last quarter
  // hour, then lunch prep at 10:30 (touches the call, overlaps nothing)
  const p = packDayWithSleeves([
    { item: "planning", startMin: m(9, 30), endMin: m(10, 15) },
    { item: "call", startMin: m(10), endMin: m(10, 30) },
    { item: "prep", startMin: m(10, 30), endMin: m(11) },
  ], PX);
  const call = p.regular.find((r) => r.item === "call")!;
  const prep = p.regular.find((r) => r.item === "prep")!;
  // got: call drawn to 10:36 (509px, 5px past its 504px end)
  expect(call.top + call.height, "the call ends at 10:30").toBeLessThanOrEqual(m(10, 30) * PX + 0.5);
  // got: 509 (10:36); 4c8bf2fb drew it at 504 (10:30)
  expect(prep.top, "lunch prep starts at 10:30").toBeCloseTo(m(10, 30) * PX, 0);
});

test("layout: a 15-minute event after an overlap doesn't push the next one 16 minutes down", () => {
  const p = packDayWithSleeves([
    { item: "a", startMin: m(9), endMin: m(10, 10) },
    { item: "b", startMin: m(10), endMin: m(10, 15) },
    { item: "c", startMin: m(10, 15), endMin: m(11) },
  ], PX);
  const c = p.regular.find((r) => r.item === "c")!;
  // got: 505 (10:31); 4c8bf2fb: 497 (10:21)
  expect(c.top - m(10, 15) * PX, "c's top, px below 10:15").toBeLessThanOrEqual(6);
});

test("week: a back-to-back event after a short overlap sits on its hour line", async ({ page }) => {
  await boot(page, "2026-10-14T08:00:00", [
    timed("a", "Planning", "2026-10-14T09:30", "2026-10-14T10:15"),
    timed("b", "Call", "2026-10-14T10:00", "2026-10-14T10:30"),
    timed("c", "Lunch prep", "2026-10-14T10:30", "2026-10-14T11:00"),
  ]);
  await page.getByTestId("week-grid").evaluate((el) => { el.scrollTop = 8 * 48; });
  const col = (await page.getByTestId("day-col-3").boundingBox())!;
  const call = (await page.locator(".chip-timed", { hasText: "Call" }).first().boundingBox())!;
  const prep = (await page.locator(".chip-timed", { hasText: "Lunch prep" }).first().boundingBox())!;
  // got: Call's box ends ~5px below the 10:30 line (10:36)
  expect(call.y + call.height - (col.y + 10.5 * 48)).toBeLessThanOrEqual(1.5);
  // got: Lunch prep's top 5px below the 10:30 line (10:36); 4c8bf2fb: on it
  expect(Math.abs(prep.y - (col.y + 10.5 * 48))).toBeLessThanOrEqual(1.5);
});

// ---------------------------------------------------------------------------
// Quick create (d5dac5fa)

const REF = new Date(2026, 9, 14, 10, 0); // Wed Oct 14 2026, 10 AM
const day = (d: Date) => d.toDateString();

test("quick create: 'the 21st' before 'by'/'noon' is still the date", () => {
  for (const text of ["due the 21st by 5pm", "lunch the 21st noon", "submit the 21st before noon"]) {
    const r = parseQuickCreate(text, REF)!;
    // got: Wed Oct 14 (today), with "the 21st" left in the title
    expect(day(r.start), text).toBe(day(new Date(2026, 9, 21)));
    expect(r.title, text).not.toMatch(/21st/);
  }
});

test("quick create: a dated midnight is the night that ends that day, like a weekday's", () => {
  // Oct 20 is a Tuesday: 'tue midnight' is still Wed 00:00 on HEAD
  const viaWeekday = parseQuickCreate("movie tue midnight", REF)!;
  expect(viaWeekday.start.getTime()).toBe(new Date(2026, 9, 21, 0, 0).getTime());
  for (const text of ["movie oct 20 midnight", "party 10/20 midnight"]) {
    const r = parseQuickCreate(text, REF)!;
    // got: Tue Oct 20 00:00, a day earlier than 'movie tue midnight'
    expect(r.start.getTime(), text).toBe(viaWeekday.start.getTime());
  }
  // got: Thu Dec 31 00:00 (a day early for New Year)
  expect(parseQuickCreate("new year midnight dec 31", REF)!.start.getTime()).toBe(new Date(2027, 0, 1, 0, 0).getTime());
});

// ---------------------------------------------------------------------------
// Series edits (0da32437): an 'All events' / 'This and following' edit of a
// moved occurrence is now measured from its original slot even when only its
// time or length changed, so the whole series jumps to the moved-to weekday.

async function spySeries(page: Page, master: unknown) {
  await page.evaluate((mst) => {
    const be = (window as any).__mockBackend;
    (window as any).__calls = [];
    be.getSeriesMaster = async () => JSON.parse(JSON.stringify(mst));
    for (const name of ["updateSeriesMaster", "splitSeries"]) {
      const orig = be[name].bind(be);
      be[name] = (...args: any[]) => {
        (window as any).__calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
        return orig(...args);
      };
    }
  }, master);
}
const callsOf = (page: Page) => page.evaluate(() => (window as any).__calls as { name: string; args: any[] }[]);
// weekly Monday 10-11 AM in New York (the computer's own zone); the Oct 19
// occurrence was earlier moved to Tue Oct 20 ('This event')
const MASTER = {
  id: "wk", summary: "Weekly review", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
  start: { dateTime: "2026-10-12T10:00:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-10-12T11:00:00-04:00", timeZone: "America/New_York" },
};
const occ = (s: string, orig: string) => ev({
  id: `wk_${orig}`, calendar_id: "p", summary: "Weekly review", start: s, end: s.replace("T10", "T11"),
  timezone: "America/New_York", recurring_event_id: "wk",
  raw: { masterRecurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"], originalStartTime: { dateTime: orig, timeZone: "America/New_York" } },
});
const SERIES = [
  occ("2026-10-12T10:00:00-04:00", "2026-10-12T10:00:00-04:00"),
  occ("2026-10-20T10:00:00-04:00", "2026-10-19T10:00:00-04:00"),
  occ("2026-10-26T10:00:00-04:00", "2026-10-26T10:00:00-04:00"),
];
async function openMoved(page: Page) {
  await boot(page, "2026-10-19T08:00:00", SERIES);
  await spySeries(page, MASTER);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
  await page.getByTestId("day-col-2").locator(".chip-timed", { hasText: "Weekly review" }).click(); // Tue Oct 20
  return page.getByTestId("event-panel");
}

test("series: lengthening a moved occurrence with 'All events' keeps the series on Mondays", async ({ page }) => {
  const p = await openMoved(page);
  await expect(p.getByTestId("time-end")).toHaveValue("11:00");
  await p.getByTestId("time-end").fill("11:30"); // only the end changes
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect.poll(async () => (await callsOf(page)).length).toBe(1);
  const patch = (await callsOf(page))[0].args[2];
  // got: recurrence ["RRULE:FREQ=WEEKLY;BYDAY=TU"], start 2026-10-13T10:00:00-04:00
  expect(patch.recurrence ?? MASTER.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  expect(patch.start.dateTime).toBe("2026-10-12T10:00:00-04:00");
  expect(patch.end.dateTime).toBe("2026-10-12T11:30:00-04:00");
});

test("series: a new start time on a moved occurrence with 'This and following' keeps the rule on Mondays", async ({ page }) => {
  const p = await openMoved(page);
  await p.getByTestId("time-start").fill("11:00");
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect.poll(async () => (await callsOf(page)).length).toBe(1);
  // got: "RRULE:FREQ=WEEKLY;BYDAY=TU"
  expect((await callsOf(page))[0].args[3].recurrence[0]).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
});

// ---------------------------------------------------------------------------
// All-day drag highlight (9f7b04fc): a multi-day chip lights `span` columns
// from the pointer's column, not the days the event will land on.

test("all-day drag: a 3-day event grabbed on its last day lights the days it will land on", async ({ page }) => {
  await boot(page, "2026-10-14T08:00:00", [ev({ id: "t", summary: "Trip", start: "2026-10-12", end: "2026-10-15", all_day: true, raw: {} })]); // Mon 12 – Wed 14
  const heads = await page.locator(".day-headers .day-head .dnum").allTextContents(); // Sun 11 … Sat 17
  const row = page.getByTestId("allday-row");
  const c = (await row.locator(".allday-cell").nth(heads.indexOf("14")).locator(".chip-allday", { hasText: "Trip" }).boundingBox())!;
  const w = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(c.x + c.width / 2, c.y + 4);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + w, c.y + 4, { steps: 8 }); // Wed's chip onto Thu: the trip shifts one day
  const lit = await row.locator(".allday-cell.drop").evaluateAll((cells) => {
    const strip = cells[0]?.closest(".pan-strip");
    const every = strip ? [...strip.querySelectorAll(".allday-cell")] : [];
    return cells.map((x) => every.indexOf(x));
  });
  await page.mouse.up();
  const stored = await page.evaluate(async () =>
    (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")).find((r: any) => r.id === "t"));
  expect(stored.start).toBe("2026-10-13"); // lands Tue 13 – Thu 15 (right on both)
  // got: ["15", "16", "17"]: Thu, Fri, Sat lit while it lands on Tue–Thu
  // (4c8bf2fb lit only Thu, a day it does cover)
  expect(lit.map((i) => heads[i])).toEqual(expect.arrayContaining(["15"]));
  expect(lit.map((i) => heads[i]).every((d) => ["13", "14", "15"].includes(d)), `lit ${lit.map((i) => heads[i])}`).toBe(true);
});
