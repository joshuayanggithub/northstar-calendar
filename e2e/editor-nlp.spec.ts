// The event editor and quick create: found by the 2026-10-21 run 5 bug-finder
// (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";
import { parseQuickCreate } from "../src/lib/nlp";
process.env.TZ = "America/New_York"; // the parser tests run in Node; the browser is pinned by playwright.config

const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const WORK = { id: "work", summary: "Work", color: "#ff8c4f", is_primary: false, hidden: false, access_role: "owner" };
const evt = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
async function open(page: Page, fx: unknown, now = "2026-10-14T09:00:00") {
  await page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, fx);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const stored = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-06-01T00:00:00Z")));
const panel = (page: Page) => page.getByTestId("event-panel");
// Wed Oct 21 2026, 2 PM, in the suite's pinned zone (run with TZ=America/New_York
// for the parser tests: they run in Node, not the browser)
const ref = new Date(2026, 9, 21, 14, 0, 0);

// [P2] App.tsx:903-913 treats "left the fetched range" as "deleted remotely"
test("w7a: browsing ahead with the editor open keeps the editor and its edits", async ({ page }) => {
  await open(page, { calendars: [PRIMARY], events: [evt("a", "primary", "Sync", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00")] });
  await page.locator(".chip-timed", { hasText: "Sync" }).first().click();
  await panel(page).locator(".panel-title").fill("Sync moved to Nov");
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as any).__menu("next"));
    await page.waitForTimeout(250);
  }
  // HEAD: the panel closes on the 3rd week step (0 panels) and the typed
  // title is gone; nothing was saved
  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page).locator(".panel-title")).toHaveValue("Sync moved to Nov");
});

// [P3] nlp.ts:192 needs "for"; nlp.ts:216's unit filter has no "m"
test("w7a: a bare duration is the length, not a relative time or title text", () => {
  const a = parseQuickCreate("call 30m at 4", ref)!;
  // HEAD: title "call at 4pm", Wed 2:30 PM – 3:30 PM ("30m" read as "in 30 minutes")
  expect([a.title, a.start.getHours(), a.start.getMinutes(), (a.end.getTime() - a.start.getTime()) / 60000]).toEqual(["call", 16, 0, 30]);
  const b = parseQuickCreate("nov 3 3pm 2h", ref)!;
  // HEAD: title "2h", 3 PM – 4 PM
  expect([b.title, b.start.getHours(), (b.end.getTime() - b.start.getTime()) / 60000]).toEqual(["(no title)", 15, 120]);
  const c = parseQuickCreate("standup 15 min at 9am", ref)!;
  // HEAD: title "standup 15 min", 9 – 10 AM
  expect([c.title, (c.end.getTime() - c.start.getTime()) / 60000]).toEqual(["standup", 15]);
});

// [P3] nlp.ts:90 treats "9p"/"9a" as already having a meridiem, chrono doesn't read it
test("w7a: '9p' / '12:30p' are times", () => {
  const a = parseQuickCreate("call tomorrow 9p", ref)!;
  // HEAD: all-day Thu "call 9p"
  expect([a.title, a.allDay, a.start.getDate(), a.start.getHours()]).toEqual(["call", false, 22, 21]);
  const b = parseQuickCreate("lunch 12:30p", ref)!;
  // HEAD: "lunch 12:30p" at the next hour (3 PM today)
  expect([b.title, b.start.getHours(), b.start.getMinutes()]).toEqual(["lunch", 12, 30]);
});

// [P3] QuickCreate.tsx:42-43 picks the primary even when it is hidden
test("w7a: quick create with the primary calendar hidden lands somewhere visible", async ({ page }) => {
  await open(page, { calendars: [{ ...PRIMARY, hidden: true }, WORK], events: [] });
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill("lunch 12-1");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-create")).toHaveCount(0);
  // HEAD: stored on "primary" (hidden), 0 chips drawn, toast "Created “lunch”"
  await expect(page.locator(".chip-timed", { hasText: "lunch" })).toHaveCount(1);
  expect((await stored(page)).map((e: any) => e.calendar_id)).toEqual(["work"]);
});
