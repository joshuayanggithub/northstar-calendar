// Week-grid caches and the cluster wrap: found by the 2026-10-21 run 5
// bug-finder (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";
import { packDayWithSleeves } from "../src/lib/layout";

const cal = (id: string, summary: string, color: string) =>
  ({ id, summary, color, is_primary: id === "p", hidden: false, access_role: "owner" });
const ev = (id: string, summary: string, start: string, end: string, calendar_id = "p", all_day = false) => ({
  id, calendar_id, etag: null, summary, description: null, location: null,
  start: all_day ? start : `${start}:00-04:00`, end: all_day ? end : `${end}:00-04:00`, all_day,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
async function open(page: Page, now: string, events: unknown[], calendars: unknown[]) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars, events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
}
const PX = 48 / 60, m = (h: number, min = 0) => h * 60 + min;
const pad = (n: number) => String(n).padStart(2, "0");

// ---- cluster wrap: whichever side moves, it's the one that moves less ----
// A long event starting inside a cluster's run either wraps the list (the
// list goes under its title) or is pushed below the list. The layout takes
// the smaller displacement: at 10:29 of a 10:00–10:30 run of five, wrapping
// moves the list 40px and not wrapping moves the event 58px, so it wraps;
// got (first cut): the list always wrapped, 10:50 even when the event's own
// push would have been smaller.
test("layout: a long event late in a cluster's run: the smaller displacement wins", () => {
  const shorts = [0, 5, 10, 15, 20].map((s, i) => ({ item: `s${i}`, startMin: m(10, s), endMin: m(10, s + 10) }));
  for (const [startMin, label] of [[m(10, 29), "10:29"], [m(10, 15), "10:15"], [m(10, 5), "10:05"], [m(10, 45), "10:45"], [m(11), "11:00"]] as const) {
    const p = packDayWithSleeves([...shorts, { item: "review", startMin, endMin: m(12) }], PX);
    expect(p.clusters, label).toHaveLength(1);
    const c = p.clusters[0];
    const long = p.containers.find((x) => x.item === "review") ?? p.regular.find((x) => x.item === "review")!;
    const listPush = c.top - m(10) * PX;
    const eventPush = long.top - startMin * PX;
    // one of them is on its line; the other moved by no more than the
    // alternative would have (81px of rows: the list's run is 30 min = 24px)
    // (the list's natural place is 10:00; its rows need 81px)
    const alt = eventPush < 0.5 ? (m(10) * PX + 81) - startMin * PX : (startMin - m(10)) * PX + 17;
    expect(Math.min(listPush, eventPush), label).toBeLessThanOrEqual(0.5);
    expect(Math.max(listPush, eventPush), label).toBeLessThanOrEqual(alt + 0.5);
  }
});

// ---- P3: day score keeps the old deep-work calendars ----
test("score: turning a calendar's deep work off in Settings re-scores the week's headers", async ({ page }) => {
  const cals = [cal("p", "Personal", "#4986e7"), cal("hw", "Homework", "#2fbf71")];
  await open(page, "2026-10-16T20:00:00", [
    ev("d1", "Problem set", "2026-10-12T09:00", "2026-10-12T11:00", "hw"),
    ev("d2", "Essay", "2026-10-12T14:00", "2026-10-12T16:00", "hw"),
    ev("x", "lunch", "2026-10-12T12:00", "2026-10-12T13:00"),
  ], cals);
  const score = () => page.locator('.day-head[data-day="2026-10-12"] [data-testid="day-score"]')
    .textContent({ timeout: 1500 }).catch(() => null);
  const before = await score();
  expect(before).not.toBeNull();
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings").getByText("Insights & review").click();
  await page.getByRole("switch", { name: "Homework counts as deep work" }).click();
  await page.keyboard.press("Escape");
  await page.locator(".chip-timed", { hasText: "lunch" }).hover(); // any later render
  await page.waitForTimeout(300);
  const shown = await score();
  await page.reload(); // the same prefs, scored fresh
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const fresh = await score();
  expect(fresh, "Homework no longer deep changes Monday's score").not.toBe(before);
  // got: "86" kept on screen (until the clock's minute changes; with ?now= forever)
  expect(shown).toBe(fresh);
});

// ---- P3: dense cluster rows unmounted after the all-day row collapses ----
// WKWebView has no CSS scroll anchoring; Chromium's anchoring fires a scroll
// event that happens to re-measure, so turn it off to match the app's engine.
test("rows: collapsing a tall all-day row keeps the cluster rows on screen mounted", async ({ page }) => {
  const at = (min: number) => `2026-10-14T${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
  await open(page, "2026-10-14T08:00:00", [
    ...Array.from({ length: 200 }, (_, i) => ev(`r${i}`, `row ${i}`, at(480 + i * 2), at(500 + i * 2))),
    ...Array.from({ length: 24 }, (_, i) => ev(`a${i}`, `allday ${i}`, "2026-10-15", "2026-10-16", "p", true)),
  ], [cal("p", "Personal", "#4986e7")]);
  await page.addStyleTag({ content: "[data-testid=week-grid]{overflow-anchor:none}" });
  await page.locator(".allday-more").first().click(); // open: ~450px tall
  await page.getByTestId("week-grid").evaluate((el) => { el.scrollTop = 300; });
  await page.waitForTimeout(300);
  await page.locator(".allday-more").first().click(); // close: ~73px
  await page.waitForTimeout(300);
  const hits = await page.evaluate(() => {
    const g = document.querySelector('[data-testid="week-grid"]')!.getBoundingClientRect();
    const blk = document.querySelector('[data-testid="day-col-3"] [data-testid="cluster-block"]')!.getBoundingClientRect();
    const out: string[] = [];
    for (let y = g.bottom - 100; y < g.bottom - 5; y += 20) {
      out.push((document.elementFromPoint(blk.left + blk.width / 2, y) as HTMLElement).className.split(" ")[0]);
    }
    return out;
  });
  // got: the bottom ~100px of the viewport show the bare cluster block (no rows)
  expect(hits.every((c) => c === "cluster-row")).toBe(true);
});

// A cluster whose run a long event starts well into (an hour in) is split
// there: the rows before stay at their time, the rows after nest inside
// the event. Wrapping the whole list left the first hour blank.
test("layout: a long event an hour into a cluster's run splits the list instead of leaving the hour blank", () => {
  const shorts = [0, 0, 5, 20, 60, 65, 70, 90].map((s, i) => ({ item: `s${i}`, startMin: m(12, 30) + s, endMin: m(12, 30) + s + 15 }));
  const p = packDayWithSleeves([...shorts, { item: "long", startMin: m(13, 30), endMin: m(18) }], PX);
  const long = p.containers.find((x) => x.item === "long") ?? p.regular.find((x) => x.item === "long")!;
  // (within a title row: a short event split off the run sits above it)
  expect(Math.abs(long.top - m(13, 30) * PX), "the long event starts near its line").toBeLessThanOrEqual(20);
  // the 12:30 rows are drawn at 12:30 (got: 81 minutes late, under a 1:30 title)
  const first = p.clusters.find((c) => c.items.some((it) => it.item === "s0"));
  const s0 = first ? first.top : p.regular.find((x) => x.item === "s0")!.top;
  expect(Math.abs(s0 - m(12, 30) * PX)).toBeLessThanOrEqual(1);
});
