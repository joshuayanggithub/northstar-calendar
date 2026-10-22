// The Insights dashboard: a period against the same stretch before it (fair
// on a Monday morning), period tabs that stick, and the charts' basics.
import { expect, test, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const HW = { id: "hw", summary: "Homework", color: "#e9a23b", is_primary: false, hidden: false, access_role: "owner" };
const ev = (id: string, cal: string, summary: string, start: string, end: string) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
async function open(page: Page, events: unknown[], now: string) {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [P, HW], events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
  await page.keyboard.press("i");
  await expect(page.getByTestId("insights-view")).toBeVisible();
}

test("insights: this week so far is compared with last week up to the same moment", async ({ page }) => {
  // Sunday-started weeks: now is Monday Oct 19, 2 PM
  await open(page, [
    ev("a", "hw", "Problem set", "2026-10-12T09:00:00-04:00", "2026-10-12T11:00:00-04:00"), // last Mon
    ev("b", "hw", "Essay", "2026-10-14T09:00:00-04:00", "2026-10-14T13:00:00-04:00"), // last Wed (later than "now" then)
    ev("c", "hw", "Problem set", "2026-10-19T09:00:00-04:00", "2026-10-19T11:00:00-04:00"), // this Mon
  ], "2026-10-19T14:00:00");
  await page.getByRole("tab", { name: "This week" }).click();
  const deep = page.getByTestId("ins-deepwork");
  await expect(deep.locator(".ins-big")).toHaveText("2h");
  // not "down 4h vs last week": last week had only 2h by Monday 2 PM
  await expect(deep.locator(".ins-delta")).toHaveText(/same as last wk so far/);
});

test("insights: the period tab switches the range and sticks", async ({ page }) => {
  await open(page, [ev("c", "hw", "Problem set", "2026-10-19T09:00:00-04:00", "2026-10-19T11:00:00-04:00")], "2026-10-19T14:00:00");
  await expect(page.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("insights-view").locator(".ins-head .ins-note")).toContainText("Oct 13 – Oct 19");
  await page.getByRole("tab", { name: "4 weeks" }).click();
  await expect(page.getByTestId("insights-view").locator(".ins-head .ins-note")).toContainText("Sep 22 – Oct 19");
  await expect(page.getByTestId("ins-deepwork").locator(".ins-mini-bar")).toHaveCount(28);
  await page.reload();
  await expect(page.locator(".mock-badge")).toBeVisible();
  await page.keyboard.press("i");
  await expect(page.getByRole("tab", { name: "4 weeks" })).toHaveAttribute("aria-selected", "true");
});

test("insights: sleep shows a bar per night from falling asleep to waking", async ({ page }) => {
  await open(page, [
    ev("s1", "p", "Sleep", "2026-10-16T23:30:00-04:00", "2026-10-17T07:30:00-04:00"),
    ev("s2", "p", "Sleep", "2026-10-18T01:00:00-04:00", "2026-10-18T06:00:00-04:00"),
  ], "2026-10-19T14:00:00");
  const chart = page.getByTestId("ins-sleep-chart");
  await expect(chart.locator(".ins-sleep-bar")).toHaveCount(2);
  await expect(chart.locator(".ins-sleep-bar.short")).toHaveCount(1); // the 5h night
  await expect(chart.locator(".ins-sleep-col").nth(4)).toHaveAttribute("title", /11:30 PM – 7:30 AM, 8h/);
  await expect(page.getByTestId("ins-sleep").locator(".ins-big")).toHaveText("6h30");
});

test("insights: where the time went leaves sleep aside and lists calendars by hours", async ({ page }) => {
  await open(page, [
    ev("h", "hw", "Problem set", "2026-10-18T09:00:00-04:00", "2026-10-18T12:00:00-04:00"),
    ev("l", "p", "Lunch", "2026-10-18T12:00:00-04:00", "2026-10-18T13:00:00-04:00"),
    ev("s", "p", "Sleep", "2026-10-18T00:00:00-04:00", "2026-10-18T08:00:00-04:00"),
  ], "2026-10-19T14:00:00");
  const legend = page.getByTestId("ins-alloc").locator(".ins-legend li");
  await expect(legend).toHaveCount(2);
  await expect(legend.nth(0)).toContainText("Homework");
  await expect(legend.nth(0)).toContainText("75%");
  await expect(legend.nth(0)).toHaveAttribute("title", "3h");
  await expect(legend.nth(1)).toContainText("25%"); // Personal: lunch only, not the 8h of sleep
  await expect(legend.nth(1)).toHaveAttribute("title", "1h");
});

test("insights: plan kept counts reviewed blocks that happened, and every chart reads itself", async ({ page }) => {
  const d = (n: number, h: number) => `2026-10-${String(n).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00-04:00`;
  const blocks = [15, 16, 17, 18].flatMap((n) => [ev(`a${n}`, "hw", "Problem set", d(n, 9), d(n, 11)), ev(`b${n}`, "p", "Gym", d(n, 17), d(n, 18))]);
  await page.addInitScript(() => {
    const at = Date.parse("2026-10-19T09:00:00-04:00");
    localStorage.setItem("recon-since", String(Date.parse("2026-10-01T12:00:00-04:00")));
    localStorage.setItem("recon", JSON.stringify({
      a15: { s: "done", at }, a16: { s: "done", at }, a17: { s: "canceled", at }, a18: { s: "done", at },
      b15: { s: "done", at }, b16: { s: "canceled", at },
    }));
  });
  await open(page, blocks, "2026-10-19T14:00:00");
  const kept = page.getByTestId("ins-plan-kept");
  await expect(kept.locator(".ins-big")).toHaveText("67%"); // 4 of 6 reviewed happened
  await expect(kept).toContainText("4 of 6 reviewed blocks happened");
  await expect(kept).toContainText("2 not reviewed");
  // the readings
  await expect(page.getByTestId("ins-alloc").locator(".ins-take")).toContainText("Homework");
  await expect(page.getByTestId("ins-fragmentation").locator(".ins-take")).toContainText(/Mostly 9 AM–12 PM/);
  await expect(page.getByTestId("ins-forecast").locator(".ins-take")).toBeVisible();
});
