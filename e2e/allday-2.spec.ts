// All-day round trips: found by the 2026-10-21 run 5 bug-finder (failed
// before its fix).
import { expect, test, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const ev = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end, all_day: !start.includes("T"),
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
async function open(page: Page, now: string, events: unknown[]) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [P], events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const stored = async (page: Page, id: string) => (await page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")))).find((e: any) => e.id === id);

// [P3] got: panel "Fri, Oct 9 – Thu, Oct 15", stored ["2026-10-09", "2026-10-16"] (a 3-day retreat became 7 days)
test("all-day switched off, start date moved, switched back on: keeps its 3-day span", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [ev("r", "Retreat", "2026-10-13", "2026-10-16")]); // Tue–Thu
  await page.locator(".chip-allday", { hasText: "Retreat" }).first().click();
  const p = page.getByTestId("event-panel");
  await p.getByRole("button", { name: "All-day" }).click(); // off (9–10)
  await p.locator(".panel-date-pretty").click();
  const date = p.locator('input[type="date"]:not(.allday-end)');
  await date.fill("2026-10-09"); // to the Friday before
  await date.blur();
  await p.getByRole("button", { name: "All-day" }).click(); // back on, times untouched
  await expect(p.getByTestId("allday-end")).toHaveValue("2026-10-11"); // got 2026-10-15
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => { const r = await stored(page, "r"); return [r.start, r.end]; })
    .toEqual(["2026-10-09", "2026-10-12"]); // got ["2026-10-09", "2026-10-16"]
});
