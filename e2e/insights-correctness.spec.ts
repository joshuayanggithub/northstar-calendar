// Insights correctness: found by the 2026-10-19 run 4 bug-finder (each failed
// before its fix).
// Insights correctness regressions (bug-finder run, 2026-10-19). Each test
// fails on 9089e664/e913075b with the "got" noted beside it.
process.env.TZ = "America/New_York"; // unit tests run in Node; the browser is pinned by playwright.config
import vm from "node:vm";
import { expect, test, type Page } from "@playwright/test";
import { bucketDays, focusScore, sleepWindows } from "../src/lib/insights";
import type { Calendar, CalendarEvent } from "../src/lib/types";

const C = (id: string, summary: string): Calendar => ({ id, summary, color: "#888888", is_primary: id === "p", hidden: false, access_role: "owner" });
const CALS = [C("p", "Personal"), C("hw", "Homework"), C("lr", "Learning and Research"), C("di", "Distractions"), C("sl", "Sleep")];
const ev = (id: string, cal: string, summary: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** an EDT timestamp on local date d at h:m */
const at = (d: Date, h: number, m = 0) => `${ymd(d)}T${pad(h)}:${pad(m)}:00-04:00`;
/** a Sleep-calendar night ending on Oct `day`, from sh:sm (the evening before if sh >= 12) */
const night = (id: string, day: number, summary: string, sh: number, sm: number, eh: number, em: number, extra: Partial<CalendarEvent> = {}) => {
  const end = new Date(2026, 9, day);
  return ev(id, "sl", summary, at(sh >= 12 ? new Date(2026, 9, day - 1) : end, sh, sm), at(end, eh, em), extra);
};
async function boot(page: Page, events: unknown[], now: string) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: CALS, events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
async function open(page: Page, events: unknown[], now: string) {
  await boot(page, events, now);
  await page.keyboard.press("i");
  await expect(page.getByTestId("insights-view")).toBeVisible();
}
const recon = (page: Page, marks: Record<string, unknown>, since?: number) =>
  page.addInitScript(([m, s]) => {
    localStorage.setItem("recon", JSON.stringify(m));
    if (s) localStorage.setItem("recon-since", String(s));
  }, [marks, since] as const);

// 1 ─ DST hang
const lateNov1 = ev("s", "sl", "Sleep", "2026-11-01T23:30:00-05:00", "2026-11-02T07:30:00-05:00");
test("1 unit: bucketDays finishes for a night that starts 11:30 PM on Nov 1 (DST ends)", () => {
  const run = () => bucketDays([lateNov1], CALS, new Date(2026, 10, 1), new Date(2026, 10, 3), { now: new Date(2026, 10, 3, 12), recon: () => null, reconSince: null });
  // got: "Script execution timed out after 2000ms" (infinite loop)
  const days = vm.runInContext("run()", vm.createContext({ run }), { timeout: 2000 }) as ReturnType<typeof run>;
  expect(days.map((d) => d.sleepH)).toEqual([0.5, 7.5]);
});
test("1 e2e: Insights opens after a night that began 11:30 PM Nov 1", async ({ page }) => {
  await boot(page, [lateNov1], "2026-11-03T12:00:00");
  void page.keyboard.press("i").catch(() => {});
  const state = await Promise.race([
    page.getByTestId("insights-view").waitFor({ timeout: 6000 }).then(() => "insights shown"),
    new Promise<string>((r) => setTimeout(() => r("page frozen"), 6000)),
  ]).catch(() => "page frozen");
  expect(state).toBe("insights shown"); // got: "page frozen"
});

// 2 ─ 4 weeks vs a prior period that was never fetched
test("2: the same 2h every Wednesday in both months reads 'same as prior 4 wks'", async ({ page }) => {
  const weds = ["2026-08-26", "2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30", "2026-10-07", "2026-10-14"];
  await open(page, weds.map((d, i) => ev(`h${i}`, "hw", "Problem set", `${d}T09:00:00-04:00`, `${d}T11:00:00-04:00`)), "2026-10-19T14:00:00");
  await page.getByRole("tab", { name: "4 weeks" }).click();
  await expect(page.getByTestId("ins-deepwork").locator(".ins-big")).toHaveText("8h");
  // got: "▲ 6h (300%) vs prior 4 wks" + "Deep work is up 300% on the previous 4 wks (8h vs 2h)."
  await expect(page.getByTestId("ins-deepwork").locator(".ins-delta")).toHaveText(/same as prior 4 wks/);
});

// 3 ─ This week: last week's matching day scored in full
test("3: Monday 9 AM, two identical weeks: the day score reads 'same' too", async ({ page }) => {
  const a = Date.parse("2026-10-18T13:00:00-04:00");
  await recon(page, { h18: { s: "done", at: a } }, a);
  const D = (d: number) => new Date(2026, 9, d);
  await open(page, [
    night("n11", 11, "Asleep", 23, 0, 7, 0), night("n12", 12, "Asleep", 23, 0, 7, 0),
    night("n18", 18, "Asleep", 23, 0, 7, 0), night("n19", 19, "Asleep", 23, 0, 7, 0),
    ...[11, 12, 18, 19].map((d) => ev(`h${d}`, "hw", "Problem set", at(D(d), 10), at(D(d), 12))),
  ], "2026-10-19T09:00:00");
  await page.getByRole("tab", { name: "This week" }).click();
  await expect(page.getByTestId("ins-deepwork").locator(".ins-delta")).toHaveText(/same as last wk so far/); // passes
  // got: "▼ 41 pts (50%) vs last wk so far" (last Monday scored for its whole day: 81; this Monday at 9 AM: 0)
  await expect(page.getByTestId("ins-score").locator(".ins-delta")).toHaveText(/same as last wk so far/);
});

// 4 ─ unreviewed deep work: full in the 48h window, half after
test("4: the same unreviewed 2h every day in both weeks isn't 'up 29%'", async ({ page }) => {
  await recon(page, {}, Date.parse("2026-10-01T12:00:00-04:00"));
  await open(page, Array.from({ length: 14 }, (_, i) => ev(`h${i}`, "hw", "Problem set", at(new Date(2026, 9, 6 + i), 9), at(new Date(2026, 9, 6 + i), 11))), "2026-10-19T14:00:00");
  // got: "▲ 2h (29%) vs prior 7 days" and "Deep work is up 29% on the previous 7 days (9h vs 7h)."
  await expect(page.getByTestId("ins-deepwork").locator(".ins-delta")).toHaveText(/same as prior 7 days/);
});

// 5 ─ overlapping blocks counted twice
test("5: 9–11 + 10–12 deep work is 3h; 9–10 + 9:30–10:30 PM distraction is 1h30", async ({ page }) => {
  const D = new Date(2026, 9, 15);
  await open(page, [
    ev("a", "hw", "Problem set", at(D, 9), at(D, 11)), ev("b", "lr", "Reading", at(D, 10), at(D, 12)),
    ev("c", "di", "Distraction: YouTube", at(D, 21), at(D, 22)), ev("d", "di", "Distraction: Twitter", at(D, 21, 30), at(D, 22, 30)),
  ], "2026-10-19T14:00:00");
  await expect.soft(page.getByTestId("ins-deepwork").locator(".ins-big")).toHaveText("3h"); // got: "4h"
  await expect.soft(page.getByTestId("ins-distraction").locator(".ins-big")).toHaveText("1h30"); // got: "2h" (the day score says 90m)
});

// 6 ─ sleep headline falls back to the recurring plan
const plan = (from: number) => Array.from({ length: 14 }, (_, i) => night(`p${i}`, from + i, "Sleep", 23, 0, 7, 0, { recurring_event_id: "plan" }));
test("6a: only the recurring Sleep plan: no sleep number", async ({ page }) => {
  await open(page, plan(6), "2026-10-19T14:00:00");
  await expect(page.getByTestId("ins-sleep-chart")).toContainText("No measured sleep in this period."); // passes
  await expect(page.getByTestId("ins-sleep").locator(".ins-big")).toHaveText("–"); // got: "7h51"
});
test("6b: measured 6h nights aren't '▼ 2h' against last week's plan", async ({ page }) => {
  await open(page, [...plan(6), ...Array.from({ length: 7 }, (_, i) => night(`t${i}`, 13 + i, "Asleep", 1, 0, 7, 0))], "2026-10-19T14:00:00");
  await expect(page.getByTestId("ins-sleep").locator(".ins-big")).toHaveText("6h");
  await expect(page.getByTestId("ins-sleep").locator(".ins-delta")).toHaveCount(0); // got: "▼ 2h (25%) vs prior 7 days"
});
test("6c: This week at Sunday 12:30 AM with the plan isn't '30m a night'", async ({ page }) => {
  await open(page, plan(5), "2026-10-18T00:30:00");
  await page.getByRole("tab", { name: "This week" }).click();
  await expect(page.getByTestId("ins-sleep").locator(".ins-big")).toHaveText("–"); // got: "30m"
});

// 7 ─ a canceled Sleep block still counts as a night
test("7 e2e: a Sleep block canceled ahead of time (an all-nighter) isn't a night", async ({ page }) => {
  const c = night("s16", 16, "Sleep", 23, 0, 7, 0);
  await recon(page, { s16: { s: "canceled", at: Date.parse("2026-10-15T20:00:00-04:00"), for: `${Date.parse(c.start)}|${Date.parse(c.end)}` } });
  await open(page, [...[13, 14, 15, 17, 18, 19].map((d) => night(`s${d}`, d, "Sleep", 23, 30, 6, 30)), c], "2026-10-19T14:00:00");
  await expect.soft(page.getByTestId("ins-sleep-chart").locator(".ins-sleep-col").nth(3)).toHaveAttribute("title", "Fri Oct 16: no data"); // got: "…11 PM – 7 AM, 8h"
  await expect.soft(page.getByTestId("ins-sleep").locator(".ins-big")).toHaveText("7h"); // got: "7h09"
});
test("7 unit: the day score's sleep ignores a canceled Sleep block", () => {
  const f = focusScore({ day: new Date(2026, 9, 16), now: new Date(2026, 9, 19, 14), events: [night("s16", 16, "Sleep", 23, 0, 7, 0)], calendars: CALS, recon: () => "canceled", reconSince: null });
  expect(f.sleep).toBeNull(); // got: { hours: 8, onset: 23, … } → "Slept 8h"
});

// 8 ─ "Fri/Sat nights" are the nights ending Fri/Sat
test("8: Friday and Saturday nights at 1 AM, the rest at 11 PM: 120m later", async ({ page }) => {
  await open(page, [13, 14, 15, 16, 17, 18, 19].map((d) => (d === 17 || d === 18 ? night(`n${d}`, d, "Sleep", 1, 0, 9, 0) : night(`n${d}`, d, "Sleep", 23, 0, 7, 0))), "2026-10-19T14:00:00");
  // got: "8h a night · every night 7h+." (Thu+Fri nights vs the rest: 36m, under the 45m bar)
  await expect(page.getByTestId("ins-sleep-chart").locator(".ins-take")).toContainText("bedtime 120m later on Fri/Sat nights");
});

// 9 ─ "a day" figures are 4-week totals
test("9: 2h every weekday, none at weekends: '2h vs 0m a day', as the chart says", async ({ page }) => {
  const days = Array.from({ length: 28 }, (_, n) => new Date(2026, 8, 22 + n)).filter((d) => d.getDay() % 6 !== 0);
  await open(page, days.map((d, i) => ev(`h${i}`, "hw", "Problem set", at(d, 9), at(d, 11))), "2026-10-19T14:00:00");
  const p = page.getByTestId("ins-fragmentation");
  await expect(p.locator(".ins-dow-col").nth(1)).toHaveAttribute("title", "Mon: 2h a day"); // passes
  await expect(p.locator(".ins-take")).toContainText("weekdays carry it (2h vs 0m a day)"); // got: "(8h vs 0m a day)"
});

// 10 ─ naps
test("10 e2e: a 45-minute evening nap isn't the night's bedtime", async ({ page }) => {
  await open(page, [...Array.from({ length: 7 }, (_, i) => night(`t${i}`, 13 + i, "Asleep", 23, 30, 7, 30)), ev("nap", "sl", "Asleep", "2026-10-15T18:30:00-04:00", "2026-10-15T19:15:00-04:00")], "2026-10-19T14:00:00");
  await expect.soft(page.getByTestId("ins-sleep-chart").locator(".ins-sleep-col").nth(3)).toHaveAttribute("title", "Fri Oct 16: 11:30 PM – 7:30 AM, 8h"); // got: "6:30 PM – 7:30 AM, 8h45"
  await expect.soft(page.getByTestId("ins-sleep").locator(".ins-note")).toHaveText("a night · bedtime 11:30 PM ±0m"); // got: "10:47 PM ±105m"
});
test("10 unit: a 1–1:45 PM nap isn't part of last night", () => {
  const [w] = sleepWindows([night("n", 17, "Asleep", 23, 30, 7, 30), ev("nap", "sl", "Asleep", "2026-10-17T13:00:00-04:00", "2026-10-17T13:45:00-04:00")], CALS, [new Date(2026, 9, 17)]);
  expect({ to: w!.to, hours: w!.hours }).toEqual({ to: 7.5, hours: 8 }); // got: { to: 13.75, hours: 8.75 }
});

// 11 ─ This week across Nov 1: now − 168h is an hour off the wall clock
test("11: Monday Nov 2 9:30 AM vs Monday Oct 26 9:30 AM", async ({ page }) => {
  await open(page, [
    ev("a", "hw", "Problem set", "2026-10-26T09:00:00-04:00", "2026-10-26T11:00:00-04:00"),
    ev("b", "hw", "Problem set", "2026-11-02T09:00:00-05:00", "2026-11-02T11:00:00-05:00"),
  ], "2026-11-02T09:30:00");
  await page.getByRole("tab", { name: "This week" }).click();
  await expect(page.getByTestId("ins-deepwork").locator(".ins-big")).toHaveText("30m");
  await expect(page.getByTestId("ins-deepwork").locator(".ins-delta")).toHaveText(/same as last wk so far/); // got: "▼ 1h (67%)"
});

// 12 ─ streak capped by the period
test("12: 2h every day Sep 25 – Oct 18 is a 24-day streak on every tab", async ({ page }) => {
  await open(page, Array.from({ length: 24 }, (_, i) => ev(`h${i}`, "hw", "Problem set", at(new Date(2026, 8, 25 + i), 9), at(new Date(2026, 8, 25 + i), 11))), "2026-10-19T14:00:00");
  const sub = page.getByTestId("ins-deepwork").locator(".ins-note");
  await page.getByRole("tab", { name: "4 weeks" }).click();
  await expect.soft(sub).toContainText("24-day streak of 2h+"); // passes
  await page.getByRole("tab", { name: "7 days" }).click();
  await expect.soft(sub).toContainText("24-day streak of 2h+"); // got: "6-day streak of 2h+"
  await page.getByRole("tab", { name: "This week" }).click();
  await expect.soft(sub).toContainText("24-day streak of 2h+"); // got: no streak ("1h a day")
});

// 13 ─ the focus reading's wording
test("13a: deep work spread evenly isn't 'Mostly 6 AM–9 AM'", async ({ page }) => {
  const D = new Date(2026, 9, 14);
  await open(page, [6, 9, 12, 15, 18, 21].map((h) => ev(`h${h}`, "hw", "Problem set", at(D, h), at(D, h + 1))), "2026-10-19T14:00:00");
  await expect(page.getByTestId("ins-fragmentation").locator(".ins-take")).not.toContainText("Mostly"); // got: "Mostly 6 AM–9 AM; …" (17% of it)
});
test("13b: all deep work 1–3 AM isn't 'almost none before 11 AM'", async ({ page }) => {
  await open(page, [13, 14, 15, 16, 17].map((d) => ev(`h${d}`, "hw", "Problem set", at(new Date(2026, 9, d), 1), at(new Date(2026, 9, d), 3))), "2026-10-19T14:00:00");
  await expect(page.getByTestId("ins-fragmentation").locator(".ins-take")).not.toContainText("almost none before 11 AM"); // got: "Mostly 1 AM–4 AM, almost none before 11 AM; …"
});

// 14 ─ canceled blocks are context switches
test("14: a canceled meeting between two Homework blocks isn't two switches", async ({ page }) => {
  await recon(page, { m: { s: "canceled", at: Date.parse("2026-10-15T12:00:00-04:00") } });
  const D = new Date(2026, 9, 15);
  await open(page, [ev("a", "hw", "Problem set", at(D, 9), at(D, 10)), ev("m", "p", "Club meeting", at(D, 10), at(D, 11)), ev("b", "hw", "Problem set", at(D, 11), at(D, 12))], "2026-10-19T14:00:00");
  await expect(page.getByTestId("ins-fragmentation").locator(".ins-foot")).toContainText("0.0 context switches a day"); // got: "0.3"
});

// 15 ─ declined invitations
test("15: a declined invitation isn't time spent", async ({ page }) => {
  const D = new Date(2026, 9, 15);
  const raw = { organizer: { email: "x@example.edu" }, attendees: [{ email: "me@example.edu", self: true, responseStatus: "declined" }] };
  await open(page, [ev("party", "p", "Lab party", at(D, 10), at(D, 12), { raw }), ev("h", "hw", "Problem set", at(D, 13), at(D, 15))], "2026-10-19T14:00:00");
  await expect(page.getByTestId("ins-alloc").locator(".ins-panel-head .ins-note")).toHaveText("2h on your calendars, sleep aside"); // got: "4h …" (Personal 50%)
});

// 16 ─ follow-through wording
test("16a: 'review 1 more block', not '1 more blocks'", async ({ page }) => {
  const a = Date.parse("2026-10-19T09:00:00-04:00");
  await recon(page, { a: { s: "done", at: a }, b: { s: "done", at: a } });
  await open(page, [16, 17].map((d, i) => ev("ab"[i], "hw", "Problem set", at(new Date(2026, 9, d), 9), at(new Date(2026, 9, d), 11))), "2026-10-19T14:00:00");
  await expect(page.getByTestId("ins-plan-kept")).toContainText("review 1 more block (R) to see it"); // got: "1 more blocks"
});
test("16b: tonight's 7 PM dinner isn't 'on time' at 2 PM", async ({ page }) => {
  await open(page, [13, 14, 15, 16, 17, 18, 19].map((d) => ev(`d${d}`, "p", "Dinner", at(new Date(2026, 9, d), 19), at(new Date(2026, 9, d), 19, 30))), "2026-10-19T14:00:00");
  const row = page.getByTestId("ins-routines").locator(".ins-routines li", { hasText: "Dinner" });
  await expect(row.locator(".ins-dot").nth(6)).not.toHaveAttribute("title", /on time/); // got: "Mon Oct 19: on time" (7/7)
});
