// A C-shape writes its title in a band at its top, and what it encloses
// starts below that band (lib/layout.ts packDayWithSleeves). When an
// enclosed event starts right at the C-shape's top — the tail of something
// that ran past midnight, under a sleep that starts at midnight — that
// pushed the event down off its real start (12:20 AM-looking instead of
// 12 AM). The band moves below it instead: the event keeps its time, the
// C-shape's title goes in the first open stretch that can hold it.
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves } from "../src/lib/layout";

const PX = 48 / 60; // px per minute at the default zoom
const m = (h: number, min = 0) => h * 60 + min;

test("layout: an event at a C-shape's top keeps its start; the C-shape's band goes below it", () => {
  const sleep = { item: "sleep", startMin: 0, endMin: m(9) };
  const tail = { item: "tail", startMin: 0, endMin: m(1, 30) };
  const stretch = { item: "stretch", startMin: m(8, 30), endMin: m(9) };
  const p = packDayWithSleeves([sleep, tail, stretch], PX);
  const slab = p.containers.find((c) => c.item === "sleep")!;
  const t = p.regular.find((r) => r.item === "tail")!;
  expect(slab.top).toBe(0);
  expect(t.top, "the tail starts at midnight").toBe(0);
  expect(t.top + t.height).toBeCloseTo(m(1, 30) * PX, 5);
  // the later enclosed event is untouched, and the slab still spans the night
  const s = p.regular.find((r) => r.item === "stretch")!;
  expect(s.top).toBeCloseTo(m(8, 30) * PX, 5);
  expect(slab.top + slab.height).toBeCloseTo(m(9) * PX, 5);

  // with room only at the very top (nothing open below the enclosed event
  // that could hold a title), the band stays on top: one title row
  const short = { item: "short", startMin: 0, endMin: m(1, 40) };
  const q = packDayWithSleeves([short, { item: "inner", startMin: 0, endMin: m(1, 30) }], PX);
  expect(q.regular.find((r) => r.item === "inner")!.top).toBeGreaterThan(0);

  // an enclosed event that starts later than the band never moved, and
  // still doesn't
  const r = packDayWithSleeves([sleep, { item: "late", startMin: m(2), endMin: m(3) }], PX);
  expect(r.regular.find((x) => x.item === "late")!.top).toBeCloseTo(m(2) * PX, 5);
});

async function openNight(page: Page) {
  const cal = (id: string, summary: string) => ({ id, summary, color: "#5484ed", is_primary: id === "work", hidden: false, access_role: "owner" });
  // Match playwright.config's America/New_York browser zone. `new Date(y,
  // m, ...)` would use the Linux host's Pacific zone and move the fixtures
  // three hours later in the browser.
  const at = (d: number, h: number, min = 0) =>
    new Date(`2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00-04:00`).toISOString();
  let n = 0;
  const ev = (calendar_id: string, summary: string, s: string, e: string) => ({
    id: `n${++n}`, calendar_id, etag: null, summary, description: null, location: null, start: s, end: e,
    all_day: false, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null,
    conference_url: null, updated: null, raw: {},
  });
  const fixture = {
    calendars: [cal("work", "Learning and Research"), cal("sleep", "Sleep")],
    events: [ev("work", "Read paper", at(16, 23), at(17, 1, 30)), ev("sleep", "Sleep", at(17, 0), at(17, 9))],
  };
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture);
  await page.goto(`/?now=${encodeURIComponent("2026-10-17T12:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 0));
}

test("overnight: the part after midnight starts on the 12 AM line, under a sleep that starts then", async ({ page }) => {
  await openNight(page);
  const sat = page.getByTestId("day-col-6");
  const tail = sat.locator(".chip-timed", { hasText: "Read paper" });
  await expect(tail).toHaveCount(1);
  const col = (await sat.boundingBox())!;
  const b = (await tail.boundingBox())!;
  expect(Math.abs(b.y - col.y), "starts at midnight").toBeLessThanOrEqual(1);
  expect(Math.abs(b.y + b.height - (col.y + 1.5 * 48))).toBeLessThanOrEqual(1.5);
  // Sleep's title is still shown, below the tail, inside Sleep
  const sleep = sat.locator(".chip-cfull", { hasText: "Sleep" });
  const title = sleep.locator(".chip-title").first();
  await expect(title).toBeVisible();
  const tb = (await title.boundingBox())!;
  expect(tb.y).toBeGreaterThanOrEqual(b.y + b.height - 1);
});

test("layout: an enclosed event keeps its time under a C-shape's long title (7 PM lines up across days)", () => {
  // a three-line title + time row asks for a ~56px band; dinner starts 30
  // minutes (24px) into the C-shape
  const band = (item: string) => (item === "review" ? 56 : 17);
  const review = { item: "review", startMin: m(18, 30), endMin: m(20, 30) };
  const dinner = { item: "dinner", startMin: m(19), endMin: m(19, 30) };
  const shower = { item: "shower", startMin: m(19, 30), endMin: m(20) };
  const p = packDayWithSleeves([review, dinner, shower], PX, 17, true, band);
  expect(p.regular.find((r) => r.item === "dinner")!.top, "dinner drew below the title, not at 7 PM").toBeCloseTo(m(19) * PX, 5);
  expect(p.regular.find((r) => r.item === "shower")!.top).toBeCloseTo(m(19, 30) * PX, 5);
  // the same dinner on a day without the review sits at the same height
  const alone = packDayWithSleeves([dinner, shower], PX, 17, true, band);
  expect(alone.regular.find((r) => r.item === "dinner")!.top).toBeCloseTo(m(19) * PX, 5);
  // the C-shape still spans its own time
  const slab = p.containers.find((c) => c.item === "review")!;
  expect(slab.top).toBeCloseTo(m(18, 30) * PX, 5);
  expect(slab.top + slab.height).toBeCloseTo(m(20, 30) * PX, 5);
});
