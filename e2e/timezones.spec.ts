// Time zones and recurrence: found by the 2026-10-19 run 4 bug-finder (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const CAL = [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }];
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

/** Serve the series master as Google does (start.timeZone included; the
 *  mock's master omits it) and record the series calls the app makes. */
async function spySeries(page: Page, master: unknown) {
  await page.evaluate((m) => {
    const be = (window as any).__mockBackend;
    (window as any).__calls = [];
    be.getSeriesMaster = async () => JSON.parse(JSON.stringify(m));
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

/** wall clock of an instant in a zone, e.g. "Mon 11:00" */
const wallIn = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(iso)).replace(",", "");

// ---------------------------------------------------------------------------
// [P2] Compute series edits in the series' own time zone
// A weekly series that repeats in Asia/Tokyo (Mondays 10 AM JST = Sunday 9 PM
// EDT / 8 PM EST), viewed from New York. Google expands it in Tokyo time.
const TOKYO_MASTER = {
  id: "tk", summary: "Tokyo sync", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
  start: { dateTime: "2026-10-19T10:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-10-19T11:00:00+09:00", timeZone: "Asia/Tokyo" },
};
const tokyoSeries = () => [
  ["2026-10-18T21:00:00-04:00", "2026-10-18T22:00:00-04:00", "20261019T010000Z"],
  ["2026-10-25T21:00:00-04:00", "2026-10-25T22:00:00-04:00", "20261026T010000Z"],
  ["2026-11-01T20:00:00-05:00", "2026-11-01T21:00:00-05:00", "20261102T010000Z"],
  ["2026-11-08T20:00:00-05:00", "2026-11-08T21:00:00-05:00", "20261109T010000Z"],
].map(([s, e, k]) => ev({
  id: `tk_${k}`, summary: "Tokyo sync", start: s, end: e, timezone: "Asia/Tokyo", recurring_event_id: "tk",
  raw: { masterRecurrence: TOKYO_MASTER.recurrence, originalStartTime: { dateTime: s, timeZone: "Asia/Tokyo" } },
}));

test("tz5 series zone: 'All events' 8 PM → 9 PM EST on a Tokyo series moves it to 11 AM Tokyo", async ({ page }) => {
  await boot(page, "2026-11-02T09:00:00", tokyoSeries());
  await spySeries(page, TOKYO_MASTER);
  await page.getByTestId("day-col-0").locator(".chip-timed", { hasText: "Tokyo sync" }).click(); // Sun Nov 1, 8 PM EST
  const p = page.getByTestId("event-panel");
  await expect(p.getByTestId("time-start")).toHaveValue("20:00");
  await p.getByTestId("time-start").fill("21:00");
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect.poll(async () => (await callsOf(page)).length).toBe(1);
  const patch = (await callsOf(page))[0].args[2];
  expect(patch.start.timeZone).toBe("Asia/Tokyo");
  // got: "Mon 10:00" — patch.start.dateTime "2026-10-18T21:00:00-04:00" is
  // the master's existing instant, so Google keeps the series at 8 PM EST
  // (native's local projection also leaves the occurrence at 8 PM)
  expect(wallIn(patch.start.dateTime, "Asia/Tokyo")).toBe("Mon 11:00");
});

test("tz5 series zone: 'This and following' 8 PM → 9 AM EST keeps the moved series on Sundays", async ({ page }) => {
  await boot(page, "2026-11-09T09:00:00", tokyoSeries());
  await spySeries(page, TOKYO_MASTER);
  await page.getByTestId("day-col-0").locator(".chip-timed", { hasText: "Tokyo sync" }).click(); // Sun Nov 8, 8 PM EST
  const p = page.getByTestId("event-panel");
  await p.getByTestId("time-start").fill("09:00"); // Sun 9 AM EST = Sun 11 PM Tokyo
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect.poll(async () => (await callsOf(page)).length).toBe(1);
  const input = (await callsOf(page))[0].args[3];
  expect(input.time_zone).toBe("Asia/Tokyo");
  expect(wallIn(input.start, "Asia/Tokyo")).toBe("Sun 23:00");
  // got: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] — a Sunday-in-Tokyo DTSTART with a
  // Monday rule: Google repeats it Mondays 11 PM JST = Monday 9 AM EST
  expect(input.recurrence[0]).toBe("RRULE:FREQ=WEEKLY;BYDAY=SU");
});

// ---------------------------------------------------------------------------
// [P2] Measure an "All events" move from the occurrence's original slot
test("tz5 moved occurrence: dragging it to Wednesday with 'All events' moves the series to Wednesday", async ({ page }) => {
  // weekly Monday 10 AM; the Oct 19 occurrence was earlier moved to Tue Oct 20
  const occ = (s: string, orig: string) => ev({
    id: `wk_${orig}`, summary: "Weekly review", start: s, end: s.replace("T10", "T11"),
    timezone: "America/New_York", recurring_event_id: "wk",
    raw: { masterRecurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"], originalStartTime: { dateTime: orig, timeZone: "America/New_York" } },
  });
  await boot(page, "2026-10-19T08:00:00", [
    occ("2026-10-12T10:00:00-04:00", "2026-10-12T10:00:00-04:00"),
    occ("2026-10-20T10:00:00-04:00", "2026-10-19T10:00:00-04:00"),
    occ("2026-10-26T10:00:00-04:00", "2026-10-26T10:00:00-04:00"),
  ]);
  await spySeries(page, {
    id: "wk", summary: "Weekly review", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    start: { dateTime: "2026-10-12T10:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-12T11:00:00-04:00", timeZone: "America/New_York" },
  });
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
  const b = (await page.getByTestId("day-col-2").locator(".chip-timed", { hasText: "Weekly review" }).boundingBox())!;
  const wed = (await page.getByTestId("day-col-3").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(wed.x + wed.width / 2, b.y + 10, { steps: 10 }); // Tue 10 AM → Wed 10 AM
  await page.mouse.up();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect.poll(async () => (await callsOf(page)).length).toBe(1);
  const patch = (await callsOf(page))[0].args[2];
  // got: BYDAY=TU and master start 2026-10-13 — the shift was measured from
  // the occurrence's moved day (Tue), not its slot (Mon): the series lands on
  // Tuesdays, and natively the dragged exception itself stays on Tuesday
  expect(patch.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=WE"]);
  expect(patch.start.dateTime.slice(0, 10)).toBe("2026-10-14");
});

// ---------------------------------------------------------------------------
// [P3] Show the minutes in the secondary time-zone gutter
test("tz5 gutter: a half-hour zone's labels keep their :30 (India)", async ({ page }) => {
  await boot(page, "2026-10-19T09:00:00", [], "Asia/Kolkata");
  // 1 AM EDT = 10:30 AM IST. got: "10 AM" (every label 30 minutes early)
  await expect(page.locator(".hour-label-2").nth(0)).toHaveText(/^10:30\s?AM$/);
});

test("tz5 gutter: a half-hour zone's labels keep their :30 (Newfoundland)", async ({ page }) => {
  await boot(page, "2026-10-19T09:00:00", [], "America/St_Johns");
  // 9 AM EDT = 10:30 AM NDT. got: "10 AM"
  await expect(page.locator(".hour-label-2").nth(8)).toHaveText(/^10:30\s?AM$/);
});

// ---------------------------------------------------------------------------
// [P3] Label the time gutters for the days on screen
test("tz5 gutter: the fall-back week's secondary labels don't skip an hour", async ({ page }) => {
  await boot(page, "2026-11-03T09:00:00", [], "Europe/London"); // week of Sun Nov 1
  const labels = page.locator(".hour-label-2");
  // Mon–Sat 1/2/3 AM EST = 6/7/8 AM GMT. got: "5 AM", "7 AM", "8 AM" (6 AM
  // missing; the 1 AM label is taken from Sunday's pre-change EDT hour)
  await expect(labels.nth(0)).toHaveText(/^6\s?AM$/);
  await expect(labels.nth(1)).toHaveText(/^7\s?AM$/);
});

test("tz5 gutter: a December week is labelled EST, not today's EDT", async ({ page }) => {
  await boot(page, "2026-10-19T09:00:00", []);
  for (let i = 0; i < 7; i++) await page.keyboard.press("j"); // week of Dec 6
  await expect(page.locator('[data-day="2026-12-06"]').first()).toBeAttached();
  // got: "EDT" (abbreviation computed for `now`, Oct 19)
  await expect(page.locator(".gutter-tz")).toHaveText("EST");
});
