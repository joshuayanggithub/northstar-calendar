// Locale and clock conventions: found by the 2026-10-21 run 5 bug-finder (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const CAL = [
  { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" },
  { id: "sl", summary: "Sleep", color: "#888888", is_primary: false, hidden: false, access_role: "owner" },
];
const ev = (o: Record<string, unknown>) => ({
  id: "x", calendar_id: "primary", etag: null, summary: "X", description: null, location: null,
  start: "", end: "", all_day: false, timezone: null, status: "confirmed", recurrence: null,
  recurring_event_id: null, conference_url: null, updated: null, raw: null, ...o,
});

async function boot(page: Page, now: string, events: unknown[], secondaryTz?: string) {
  await page.addInitScript(([fx, tz]) => {
    (globalThis as any).__calFixture = fx;
    if (tz) localStorage.setItem("secondaryTz", tz as string);
  }, [{ calendars: CAL, events }, secondaryTz ?? null] as const);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}

async function quickCreate(page: Page, text: string) {
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill(text);
  const preview = (await page.locator(".qc-preview").textContent()) ?? "";
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-create")).toHaveCount(0);
  return preview;
}

/** the created events with this title, as local wall clock "YYYY-MM-DD HH:mm" */
const createdAs = (page: Page, title: string) =>
  page.evaluate(async (t) => {
    const rows = await (window as any).__mockBackend.listEvents("2026-09-01T00:00:00Z", "2026-12-31T00:00:00Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const wall = (iso: string) => {
      const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    return rows.filter((e: any) => e.summary.startsWith(t.slice(0, 4)))
      .map((e: any) => ({ summary: e.summary, all_day: e.all_day, start: wall(e.start) }));
  }, title);

const is12h = (s: string) => /\b(?:AM|PM)\b/i.test(s);

// ---------------------------------------------------------------------------
// [P2] Read a zero-padded 24-hour time ("07:15") as morning in quick create
test.describe("24-hour clock (en-GB, London)", () => {
  test.use({ locale: "en-GB", timezoneId: "Europe/London" });

  test("w4b-1 quick create 'Flight tomorrow 07:15' is 7:15 in the morning", async ({ page }) => {
    await boot(page, "2026-10-21T09:00:00", []);
    const preview = await quickCreate(page, "Flight tomorrow 07:15");
    // (the preview is in the app's own 12-hour labels, like the chips)
    expect.soft(preview).toMatch(/\b7:15\b/); // got: "Flight · Thu 22 Oct · 19:15 – 20:15"
    // got: [{ summary: "Flight", start: "2026-10-22 19:15" }] (7:15 PM)
    expect(await createdAs(page, "Flight")).toEqual([{ summary: "Flight", all_day: false, start: "2026-10-22 07:15" }]);
  });
});

// ---------------------------------------------------------------------------
// [P3] Don't read a weekday out of the middle of a non-ASCII word
test("w4b-2 quick create 'Pokémon league' keeps its title and makes no Monday all-day event", async ({ page }) => {
  await boot(page, "2026-10-21T09:00:00", []);
  const preview = await quickCreate(page, "Pokémon league");
  expect.soft(preview).toMatch(/^Pokémon league · /); // got: "Poké league · Mon, Oct 26 · all day"
  // got: [{ summary: "Poké league", all_day: true, start: "2026-10-26 00:00" }]
  expect(await createdAs(page, "Pokémon league")).toEqual([{ summary: "Pokémon league", all_day: false, start: "2026-10-21 10:00" }]);
});

// ---------------------------------------------------------------------------
// Sydney springs forward on Sun Oct 4 2026, 2 AM -> 3 AM (AEST -> AEDT)
test.describe("southern-hemisphere DST (Australia/Sydney)", () => {
  test.use({ locale: "en-AU", timezoneId: "Australia/Sydney" });

  // [P3] Show the sleep chart's wake time on the wall clock across a DST change
  test("w4b-3 Insights: a night 11 PM -> 7 AM over the spring-forward reads '11 PM – 7 AM'", async ({ page }) => {
    await boot(page, "2026-10-06T10:00:00", [
      ev({ id: "s1", calendar_id: "sl", summary: "Asleep", start: "2026-10-03T23:00:00+10:00", end: "2026-10-04T07:00:00+11:00" }),
      ev({ id: "s2", calendar_id: "sl", summary: "Asleep", start: "2026-10-04T23:00:00+11:00", end: "2026-10-05T07:00:00+11:00" }),
    ]);
    await page.keyboard.press("i");
    const cols = page.getByTestId("ins-sleep-chart").locator(".ins-sleep-col");
    await expect(cols.nth(5)).toHaveAttribute("title", "Mon Oct 5: 11 PM – 7 AM, 8h"); // passes (control)
    await expect(cols.nth(4)).toHaveAttribute("title", "Sun Oct 4: 11 PM – 7 AM, 7h"); // got: "Sun Oct 4: 11 PM – 6 AM, 7h"
  });

  // [P3] Give the end-time list the same duration as the panel header on a DST day
  test("w4b-4 panel: 1:30 -> 3:30 AM on Oct 4 is 1h in the header and in the end-time list", async ({ page }) => {
    await boot(page, "2026-10-06T10:00:00", [
      ev({ id: "a", summary: "Early", start: "2026-10-04T01:30:00+10:00", end: "2026-10-04T03:30:00+11:00" }),
    ]);
    await page.locator(".chip-timed", { hasText: "Early" }).first().click();
    const p = page.getByTestId("event-panel");
    await expect(p.locator(".panel-dur")).toContainText("1h"); // passes: elapsed, by design (smoke.spec DST test)
    await p.getByTestId("time-end").focus();
    const active = page.getByTestId("time-pop").locator(".time-opt.active");
    await expect(active).toContainText("3:30 AM");
    await expect(active.locator(".time-opt-sub")).toHaveText("1h"); // got: "2h"
  });
});

// ---------------------------------------------------------------------------
// [P3] Format dates and times with one locale: a de-DE user sees English
// 12-hour labels and German 24-hour labels side by side
test.describe("one locale per screen (de-DE, Berlin)", () => {
  test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

  test("w4b-5 secondary-zone gutter uses the same clock as the main gutter", async ({ page }) => {
    await boot(page, "2026-10-21T09:00:00", [], "Europe/London");
    const primary = await page.locator(".gutter .hour-label:not(.hour-label-2)").nth(14).textContent(); // 3 PM
    const secondary = await page.locator(".gutter .hour-label-2").nth(14).textContent(); // 2 PM London
    expect(primary).toBe("3 PM");
    expect(is12h(secondary!), `main "${primary}" vs second zone "${secondary}"`).toBe(is12h(primary!)); // got: "3 PM" beside "14"
  });

  test("w4b-6 quick-create preview uses the clock the chips use", async ({ page }) => {
    await boot(page, "2026-10-21T09:00:00", []);
    const preview = await quickCreate(page, "Besprechung tomorrow 2:30pm");
    const chip = (await page.locator(".chip-timed", { hasText: "Besprechung" }).first().locator(".chip-time").textContent())!;
    expect(chip).toBe("2:30 – 3:30 PM");
    expect(is12h(preview), `preview "${preview}" vs chip "${chip}"`).toBe(true); // got: "Besprechung · Do., 22. Okt. · 14:30 – 15:30"
  });

  test("w4b-7 month view's first-of-month label is in the header's language", async ({ page }) => {
    await boot(page, "2026-10-21T09:00:00", []);
    await page.keyboard.press("m");
    await expect(page.getByTestId("month-grid")).toBeVisible();
    await expect(page.getByText("October 2026").first()).toBeVisible();
    // the first in-month cell is Oct 1
    await expect(page.locator(".month-cell:not(.out) .month-dnum").first()).toHaveText("Oct 1"); // got: "Okt 1"
  });
});
