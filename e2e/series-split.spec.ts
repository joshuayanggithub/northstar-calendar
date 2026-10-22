// "This and following" on a series whose recurrence carries EXDATE lines
// (Apple Calendar / ICS series do): Google replaces the whole recurrence
// list, so each line must go with the half of the split its dates fall in.
import { expect, test, type Page } from "@playwright/test";

const RULES = [
  "EXDATE;TZID=America/New_York:20261013T100000",
  "RRULE:FREQ=DAILY;UNTIL=20261031T000000Z",
  "EXDATE;TZID=America/New_York:20261020T100000",
];

async function open(page: Page, extraRaw: Record<string, unknown> = {}) {
  const days = [12, 14, 15, 16, 17];
  const events = days.map((d) => {
    const start = `2026-10-${d}T10:00:00-04:00`;
    return {
      id: `ts_202610${d}T140000Z`, calendar_id: "primary", etag: null, summary: "Team sync", description: null,
      location: null, start, end: `2026-10-${d}T11:00:00-04:00`, all_day: false, timezone: "America/New_York",
      status: "confirmed", recurrence: null, recurring_event_id: "ts", conference_url: null, updated: null,
      raw: { masterRecurrence: RULES, originalStartTime: { dateTime: start }, ...extraRaw },
    };
  });
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  });
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    (window as any).__calls = [];
    for (const name of ["updateSeriesMaster", "splitSeries"]) {
      const orig = be[name].bind(be);
      be[name] = (...args: any[]) => { (window as any).__calls.push({ name, args }); return orig(...args); };
    }
  });
}

test("series: delete 'this and following' keeps the earlier EXDATE lines", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Team sync" }).nth(2).click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: "Delete", exact: false }).first().click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const sent = (await page.evaluate(() => (window as any).__calls))[0].args[2].recurrence as string[];
  expect(sent).toContain("EXDATE;TZID=America/New_York:20261013T100000");
  expect(sent).not.toContain("EXDATE;TZID=America/New_York:20261020T100000");
});

test("series: edit 'this and following' splits the EXDATE lines between the halves", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Team sync" }).nth(2).click();
  const p = page.getByTestId("event-panel");
  await p.locator(".panel-title").fill("Team sync v2");
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const call = (await page.evaluate(() => (window as any).__calls)).find((c: any) => c.name === "splitSeries");
  expect(call.args[2]).toContain("EXDATE;TZID=America/New_York:20261013T100000");
  expect(call.args[2]).not.toContain("EXDATE;TZID=America/New_York:20261020T100000");
  expect(call.args[3].recurrence).toContain("EXDATE;TZID=America/New_York:20261020T100000");
  expect(call.args[3].recurrence).not.toContain("EXDATE;TZID=America/New_York:20261013T100000");
  expect(call.args[3].time_zone, "the new half repeats in the series' zone").toBe("America/New_York");
});

test("series: a drag with 'this and following' keeps the guests, reminders and busy/free", async ({ page }) => {
  await open(page, {
    attendees: [{ email: "me@example.com", self: true, responseStatus: "accepted" },
      { email: "ana@example.com", responseStatus: "accepted" }],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 5 }] },
    transparency: "transparent",
  });
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 8 * 48));
  const b = (await page.locator(".chip-timed", { hasText: "Team sync" }).nth(2).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 106, { steps: 10 });
  await page.mouse.up();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const input = (await page.evaluate(() => (window as any).__calls)).find((c: any) => c.name === "splitSeries").args[3];
  expect(input.attendee_details?.map((a: any) => [a.email, a.responseStatus])).toEqual([
    ["me@example.com", "accepted"], ["ana@example.com", "accepted"]]);
  expect(input.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 5 }] });
  expect(input.transparency).toBe("transparent");
  // and the drag's own change: two hours later
  expect(new Date(input.start).getHours()).toBe(12);
});
