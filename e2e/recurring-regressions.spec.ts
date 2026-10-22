// Recurring-event regressions found by the run-2 bug hunt (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";
const CAL = [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }];
function occ(m: string, summary: string, day: number | string, rules: string[], o: { hour?: number; offset?: string; description?: string } = {}) {
  const date = typeof day === "number" ? `2026-10-${String(day).padStart(2, "0")}` : day;
  const hh = (h: number) => String(h).padStart(2, "0");
  const h = o.hour ?? 9, offset = o.offset ?? "-04:00", start = `${date}T${hh(h)}:00:00${offset}`;
  return { id: `${m}_${date.replace(/-/g, "")}`, calendar_id: "primary", etag: null, summary, description: o.description ?? null,
    location: null, start, end: `${date}T${hh(h + 1)}:00:00${offset}`, all_day: false, timezone: "America/New_York",
    status: "confirmed", recurrence: null, recurring_event_id: m, conference_url: null, updated: null,
    raw: { masterRecurrence: rules, originalStartTime: { dateTime: start } } };
}
async function open(page: Page, events: unknown[], now = "2026-10-14T08:00:00") {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: CAL, events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  await page.evaluate(() => {
    const be = (window as any).__mockBackend; (window as any).__calls = [];
    for (const name of ["updateSeriesMaster", "splitSeries"]) {
      const orig = be[name].bind(be);
      be[name] = (...args: any[]) => { (window as any).__calls.push({ name, args: JSON.parse(JSON.stringify(args)) }); return orig(...args); };
    }
  });
}
const chip = (page: Page, id: string) => page.locator(`[data-testid="event-chip"][data-ek="primary/${id}"]`);
const rows = (page: Page) => page.evaluate(async () => (await (window as any).__mockBackend.listEvents("2026-10-01", "2026-11-30")));
const calls = (page: Page) => page.evaluate(() => (window as any).__calls as { name: string; args: any[] }[]);

test("recurring: Cmd+Z after deleting a whole series doesn't revert an unrelated earlier edit", async ({ page }) => {
  const lunch = { ...occ("x", "Lunch", 14, [], { hour: 12 }), id: "lunch", recurring_event_id: null, raw: {} };
  await open(page, [...[13, 14, 15].map((d) => occ("su", "Standup", d, ["RRULE:FREQ=DAILY;COUNT=3"])), lunch]);
  await chip(page, "lunch").click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Lunch with Ana");
  await panel.getByRole("button", { name: /^Save/ }).click();
  await expect(page.locator(".chip-timed", { hasText: "Lunch with Ana" })).toHaveCount(1);
  await chip(page, "su_20261014").click();
  await panel.getByRole("button", { name: /Delete/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(0);
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  expect((await rows(page)).map((e: any) => e.summary), "Cmd+Z reverted the Lunch rename instead").toContain("Lunch with Ana");
});

test("recurring: moving a weekly BYDAY occurrence to Thursday for all events repeats on Thursdays", async ({ page }) => {
  const WEEKLY = ["RRULE:FREQ=WEEKLY;BYDAY=WE"];
  await open(page, [occ("oo", "1:1", 14, WEEKLY), occ("oo", "1:1", 21, WEEKLY)], "2026-10-12T08:00:00");
  await chip(page, "oo_20261014").click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-date-pretty").click();
  await panel.locator('input[type="date"]:not(.allday-end)').fill("2026-10-15");
  await panel.locator('input[type="date"]:not(.allday-end)').blur();
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  const patch = (await calls(page))[0].args[2];
  expect(patch.start.dateTime.slice(0, 10)).toBe("2026-10-15");
  expect(patch.recurrence?.find((r: string) => r.startsWith("RRULE")) ?? "", JSON.stringify(patch)).toContain("BYDAY=TH");
});

test("recurring: 'this and following' keeps the edited occurrence's note and Happened mark", async ({ page }) => {
  const rules = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"];
  await open(page, [occ("rv", "Review", 13, rules), occ("rv", "Review", 14, rules, { description: "[DRILL] skipped the warmup" }),
    occ("rv", "Review", 15, rules)], "2026-10-14T12:00:00");
  const c = chip(page, "rv_20261014");
  await c.click({ button: "right", position: { x: 6, y: 6 } });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /^Happened/ }).click();
  await expect(c).not.toHaveClass(/unsettled/);
  await c.click({ position: { x: 6, y: 6 } });
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Review v2");
  await panel.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const edited = (await rows(page)).filter((e: any) => e.start.startsWith("2026-10-14") && /Review/.test(e.summary));
  expect(edited).toHaveLength(1);
  expect(edited[0].description ?? "", "the occurrence's red-pen note was erased").toContain("skipped the warmup");
  await expect(page.locator('[data-testid="event-chip"][title^="Review v2"]'), "its Happened mark was dropped").not.toHaveClass(/unsettled/);
});

test("recurring: delete 'this and following' keeps a UTC EXDATE of the kept half on an evening series", async ({ page }) => {
  const rules = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z", "EXDATE:20261014T010000Z"]; // = Oct 13, 9 PM EDT
  await open(page, [12, 14, 15].map((d) => occ("ev", "Evening review", d, rules, { hour: 21 })));
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 20 * 48));
  await chip(page, "ev_20261014").click();
  await page.getByTestId("event-panel").getByRole("button", { name: /Delete/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const sent = (await calls(page)).find((c) => c.name === "updateSeriesMaster")!.args[2].recurrence;
  expect(sent, JSON.stringify(sent)).toContain("EXDATE:20261014T010000Z");
});

test("recurring: 'this and following' picked before a failing master fetch tells the user nothing was saved", async ({ page }) => {
  const rules = ["RRULE:FREQ=DAILY;UNTIL=20261031T000000Z"];
  await open(page, [13, 14, 15].map((d) => occ("s", "Standup", d, rules)));
  await page.evaluate(() => { (window as any).__mockBackend.getSeriesMaster = () =>
    new Promise((_, reject) => setTimeout(() => reject(new Error("offline")), 800)); });
  await chip(page, "s_20261014").click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Standup v2");
  await panel.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await page.waitForTimeout(1500);
  const saved = (await rows(page)).some((e: any) => e.summary === "Standup v2");
  const toast = (await page.getByTestId("toast").textContent().catch(() => "")) ?? "";
  expect(saved || /couldn|fail|not saved/i.test(toast), `edit dropped silently; toast=${JSON.stringify(toast)}`).toBe(true);
});
