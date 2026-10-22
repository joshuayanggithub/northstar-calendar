// Insights and List view: found by the 2026-10-19 run 4 audit (each failed
// before its fix).
import { expect, test, type Page } from "@playwright/test";

const C = (id: string, summary: string) => ({ id, summary, color: "#888888", is_primary: id === "p", hidden: false, access_role: "owner" });
const CALS = [C("p", "Personal"), C("hw", "Homework"), C("lr", "Learning and Research"), C("di", "Distractions"), C("sl", "Sleep")];
const ev = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** an EDT timestamp on local date d at h:m */
const at = (d: Date, h: number, m = 0) => `${ymd(d)}T${pad(h)}:${pad(m)}:00-04:00`;
const D = (day: number, month = 9) => new Date(2026, month, day);
const NOW = "2026-10-19T14:00:00";

async function boot(page: Page, events: unknown[], now = NOW) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: CALS, events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
async function insights(page: Page, events: unknown[], now = NOW) {
  await boot(page, events, now);
  await page.keyboard.press("i");
  await expect(page.getByTestId("insights-view")).toBeVisible();
}
async function list(page: Page, events: unknown[], now = NOW) {
  await boot(page, events, now);
  await page.keyboard.press("l");
  await expect(page.getByTestId("agenda-list")).toBeVisible();
}

// ── P2 · overlapping blocks: the headline is a union since c98c5485, the charts and readings still sum
test("1a P2 overlapping YouTube + Twitter: the reading's 'after 6 PM' share isn't 133%", async ({ page }) => {
  await insights(page, [
    ev("c", "di", "Distraction: YouTube", at(D(15), 21), at(D(15), 22)),
    ev("d", "di", "Distraction: Twitter", at(D(15), 21, 30), at(D(15), 22, 30)),
  ]);
  await expect(page.getByTestId("ins-distraction").locator(".ins-big")).toHaveText("1h30"); // passes
  // got: "YouTube is 67% of it; 133% happens after 6 PM · peak 9 PM–11 PM."
  await expect(page.getByTestId("ins-distraction-chart").locator(".ins-take")).toContainText("100% happens after 6 PM");
});
test("1b P2 two overlapping YouTube entries: top source isn't bigger than the whole", async ({ page }) => {
  await insights(page, [
    ev("e", "di", "Distraction: YouTube", at(D(15), 21), at(D(15), 22)),
    ev("f", "di", "Distraction: YouTube", at(D(15), 21, 30), at(D(15), 22, 30)),
  ]);
  await expect(page.getByTestId("ins-distraction").locator(".ins-big")).toHaveText("1h30"); // passes
  await expect.soft(page.getByTestId("ins-distraction").locator(".ins-note")).toContainText("top: YouTube 1h30"); // got: "… · top: YouTube 2h"
  await expect.soft(page.getByTestId("ins-distraction-chart").locator(".ins-hbar-val").first()).toHaveText("1h30"); // got: "2h"
  // got: "YouTube is 133% of it; 133% happens after 6 PM · peak 9 PM–11 PM."
  await expect.soft(page.getByTestId("ins-distraction-chart").locator(".ins-take")).toContainText("YouTube is 100% of it");
});
test("1c P2 overlapping deep blocks: the Thursday bar agrees with the 3h headline", async ({ page }) => {
  await insights(page, [
    ev("a", "hw", "Problem set", at(D(15), 9), at(D(15), 11)),
    ev("b", "lr", "Reading", at(D(15), 10), at(D(15), 12)),
  ]);
  await expect(page.getByTestId("ins-deepwork").locator(".ins-big")).toHaveText("3h"); // passes
  // one Thursday in 4 weeks with 3h: 45m a day. got: "1h" (4h / 4)
  await expect(page.getByTestId("ins-fragmentation").locator(".ins-dow-col").nth(4).locator(".ins-dow-val")).toHaveText("45m");
});

// ── P2 · List view keeps the old scroll offset when the period changes
function busy() {
  const out = [];
  for (let k = 0; k < 28; k++) {
    const d = new Date(2026, 9, 19 + k);
    const off = d >= new Date(2026, 10, 1) ? "-05:00" : "-04:00";
    for (let h = 8; h < 20; h++) out.push(ev(`b${k}-${h}`, "p", `Block ${h}`, `${ymd(d)}T${pad(h)}:00:00${off}`, `${ymd(d)}T${pad(h)}:45:00${off}`));
  }
  return out;
}
test("2a P2 List: Next shows the new period from its first day", async ({ page }) => {
  await list(page, busy());
  const agenda = page.getByTestId("agenda-list");
  await agenda.evaluate((el) => { el.scrollTop = el.scrollHeight; }); // read to the end of Oct 19 – Nov 1
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(agenda.locator(".agenda-day").first()).toHaveText("Monday, Nov 2"); // passes
  // got: not in viewport (scrollTop kept: the list opens at ~Nov 15, Nov 2–14 above the fold)
  await expect(agenda.locator(".agenda-day").first()).toBeInViewport();
});
test("2b P2 List: Today brings today's header back into view", async ({ page }) => {
  await list(page, busy());
  const agenda = page.getByTestId("agenda-list");
  await agenda.evaluate((el) => { el.scrollTop = 3000; });
  await page.getByRole("button", { name: "Today" }).click();
  // got: not in viewport (nothing moves; scrollTop stays 3000)
  await expect(agenda.getByRole("heading", { name: /^Today · Monday, Oct 19/ })).toBeInViewport();
});

// ── P3 · List view: last night's overnight event under today reads as tonight
test("3 P3 List: last night's 11 PM – 7 AM sleep under Today names its start day", async ({ page }) => {
  await list(page, [
    ev("s1", "sl", "Sleep", at(D(18), 23), at(D(19), 7)),
    ev("s2", "sl", "Sleep", at(D(19), 23), at(D(20), 7)),
  ]);
  const today = page.getByTestId("agenda-list").locator("section").first();
  await expect(today.locator(".agenda-day")).toHaveText("Today · Monday, Oct 19"); // passes
  // got: "11:00 PM – Mon 7:00 AM" (and tonight's row below it: "11:00 PM – Tue 7:00 AM")
  await expect(today.locator(".agenda-time").first()).toContainText("Sun");
});

// ── P3 · fmtH rounds 59.5+ minutes up to "60"
test("4 P3 Sleep 8h ×6 + one 7h58 night reads '8h', not '7h60'", async ({ page }) => {
  await insights(page, [13, 14, 15, 16, 17, 18, 19].map((d) =>
    ev(`n${d}`, "sl", "Asleep", at(D(d - 1), 23, d === 16 ? 2 : 0), at(D(d), 7))));
  await expect.soft(page.getByTestId("ins-sleep").locator(".ins-big")).toHaveText("8h"); // got: "7h60"
  await expect.soft(page.getByTestId("ins-sleep-chart").locator(".ins-take")).toContainText("8h a night"); // got: "7h60 a night · every night 7h+."
});

// ── P3 · a bedtime averaging just before midnight reads "12 PM" (noon)
test("5 P3 bedtimes 11:59 PM, 12 AM, 12 AM, 12 AM read '12 AM', not '12 PM'", async ({ page }) => {
  await insights(page, [
    ev("n13", "sl", "Asleep", at(D(12), 23, 59), at(D(13), 8)),
    ...[14, 15, 16].map((d) => ev(`n${d}`, "sl", "Asleep", at(D(d), 0), at(D(d), 8))),
  ]);
  await expect.soft(page.getByTestId("ins-sleep").locator(".ins-note")).toContainText("bedtime 12 AM"); // got: "a night · bedtime 12 PM ±0m"
  await expect.soft(page.getByTestId("ins-sleep-chart").locator(".ins-panel-head .ins-note")).toContainText("asleep 12 AM"); // got: "asleep 12 PM on average"
});

// ── P3 · day-score reading when every scored day ties
test("6 P3 Day score: only sleep logged (every day 0) doesn't name one day best and lowest", async ({ page }) => {
  await insights(page, [12, 13, 14, 15, 16, 17, 18].map((d) => ev(`n${d}`, "sl", "Asleep", at(D(d - 1), 23), at(D(d), 7))));
  const take = page.getByTestId("ins-score-cal").locator(".ins-take");
  // got: "Best Mon Oct 12 (0), lowest Mon Oct 12 (0) · Sundays score highest."
  await expect.soft(take).not.toContainText(/Best (\w+ \w+ \d+) \(\d+\), lowest \1 /);
  await expect.soft(take).not.toContainText("Sundays score highest"); // no Sunday out-scored anything
});

// ── P3 · "1 pts"
test("7 P3 Day score delta of one point reads '1 pt'", async ({ page }) => {
  await insights(page, [
    ev("a", "hw", "Problem set", at(D(14), 9), at(D(14), 10, 30)),
    ev("b", "hw", "Problem set", at(D(7), 9), at(D(7), 10, 25)),
  ]);
  await expect(page.getByTestId("ins-score").locator(".ins-delta")).toHaveText(/▲ 1 pt\b/); // got: "▲ 1 pts (2%) vs prior 7 days"
});

// ── P3 · "When you focus" hour axis: 4 space-between labels over 21 columns
test("8 P3 When you focus: '6 PM' and '12 AM' labels sit under their own columns", async ({ page }) => {
  await insights(page, [13, 14, 15].map((d) => ev(`h${d}`, "hw", "Problem set", at(D(d), 18), at(D(d), 19))));
  const p = page.getByTestId("ins-fragmentation");
  const cx = async (sel: ReturnType<Page["locator"]>) => { const b = (await sel.boundingBox())!; return { c: b.x + b.width / 2, w: b.width }; };
  const col18 = await cx(p.locator(".ins-hours-col[title^='6 PM:']"));
  const lab18 = await cx(p.locator(".ins-hours-axis span", { hasText: "6 PM" }));
  const col0 = await cx(p.locator(".ins-hours-col[title^='12 AM:']"));
  const lab0 = await cx(p.locator(".ins-hours-axis span", { hasText: "12 AM" }));
  // within one column of the hour it names. got at 1280×720 (20px columns): "6 PM" 27px right of
  // the 6 PM column (over 7–8 PM), "12 AM" 39px right (over the 2 AM column)
  expect.soft(Math.abs(lab18.c - col18.c), "6 PM label offset (px)").toBeLessThan(col18.w);
  expect.soft(Math.abs(lab0.c - col0.c), "12 AM label offset (px)").toBeLessThan(col0.w);
});

// ── P3 · "longest deep block" reads the period under a 4-week panel
test("9 P3 When you focus (last 4 weeks): a week off doesn't make the longest block 0m", async ({ page }) => {
  const days = Array.from({ length: 10 }, (_, i) => new Date(2026, 8, 28 + i)).filter((d) => d.getDay() % 6);
  await insights(page, days.map((d, i) => ev(`h${i}`, "hw", "Problem set", at(d, 9), at(d, 11))));
  const p = page.getByTestId("ins-fragmentation");
  await expect(p.locator(".ins-take")).toContainText("Mostly 9 AM–12 PM"); // passes: the panel reads 4 weeks
  await expect(p.locator(".ins-foot")).toContainText("longest deep block 2h"); // got: "0.0 context switches a day · longest deep block 0m"
});

// ── P3 · List view: a long location squeezes the title at 800×600
test("10 P3 List at 800×600: the title gets at least as much room as the location", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await list(page, [ev("x", "p", "Quarterly planning offsite with the extended research team", at(D(19), 16), at(D(19), 17),
    { location: "Gates Computer Science Building, Room 104, 353 Jane Stanford Way, Stanford, CA 94305" })]);
  const row = page.getByTestId("agenda-list").locator(".agenda-row").first();
  const t = (await row.locator(".agenda-title").boundingBox())!.width;
  const l = (await row.locator(".agenda-loc").boundingBox())!.width;
  expect(t, `title ${Math.round(t)}px vs location ${Math.round(l)}px`).toBeGreaterThanOrEqual(l); // got: title 104px ("Quarterly plan…") vs location 220px
});
