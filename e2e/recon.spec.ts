// Reconciliation (did it happen?): found by the 2026-10-18 bug-finder pass
// (each failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const CALS = [
  { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" },
  { id: "hw", summary: "Homework", color: "#e9a23b", is_primary: false, hidden: false, access_role: "owner" },
  { id: "work", summary: "Work", color: "#2fbf71", is_primary: false, hidden: false, access_role: "owner" },
];
const ev = (id: string, cal: string, summary: string, start: string, end: string) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {},
});
async function open(page: Page, now = "2026-10-14T09:00:00") {
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}

test("recon: an unconfirmed block that aged out of the review window can be confirmed", async ({ page }) => {
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    if (!localStorage.getItem("recon-since")) localStorage.setItem("recon-since", String(Date.parse("2026-10-05T09:00:00-04:00")));
  }, { calendars: CALS, events: [ev("ps", "hw", "Problem set", "2026-10-11T13:00:00-04:00", "2026-10-11T15:00:00-04:00")] });
  await open(page);
  await page.locator(".chip-timed", { hasText: "Problem set" }).click();
  await page.getByTestId("event-panel").getByTestId("panel-recon-yes").click();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("recon") ?? "{}"));
  expect(stored["ps"]?.s).toBe("done");
});

test("recon: a canceled mark survives a calendar move", async ({ page }) => {
  await open(page);
  const run = page.locator(".chip-timed", { hasText: "Morning run" });
  await run.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /^Canceled/ }).click();
  await run.click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-cal-trigger").click();
  await panel.getByTestId("panel-cal-options").getByRole("option", { name: "Work" }).click();
  await panel.getByRole("button", { name: /Save/ }).click();
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveClass(/canceled/);
});

test("recon: a canceled event rescheduled to later is asked about again", async ({ page }) => {
  await page.addInitScript((fx) => {
    const s = sessionStorage.getItem("fx");
    (globalThis as any).__calFixture = s ? JSON.parse(s) : fx;
  }, { calendars: CALS, events: [ev("piano", "primary", "Piano lesson", "2026-10-14T07:00:00-04:00", "2026-10-14T08:00:00-04:00")] });
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Piano lesson" });
  await chip.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /^Canceled/ }).click();
  await page.evaluate(async () => {
    const b = (window as any).__mockBackend;
    const e = (await b.listEvents("2026-10-13", "2026-10-16")).find((r: any) => r.id === "piano");
    await b.updateEvent("piano", { ...e, start: "2026-10-15T07:00:00-04:00", end: "2026-10-15T08:00:00-04:00" }, "primary");
  });
  await page.evaluate(async (cals) => sessionStorage.setItem("fx", JSON.stringify({
    calendars: cals, events: await (window as any).__mockBackend.listEvents("2026-10-01", "2026-10-30"),
  })), CALS);
  await open(page, "2026-10-15T12:00:00");
  await expect(page.locator(".chip-timed", { hasText: "Piano lesson" })).toHaveClass(/unsettled/);
});

test("recon: r from a later week finds the queue", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 4; i++) await page.keyboard.press("j");
  await page.keyboard.press("r");
  await expect(page.getByTestId("recon-pill")).toBeVisible();
});

test("recon: skipping everything doesn't claim the day is squared away", async ({ page }) => {
  await open(page);
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  const total = Number((await pill.locator(".recon-count").textContent())!.split(" of ")[1]);
  for (let i = 0; i < total; i++) await page.keyboard.press("s");
  await expect(page.getByTestId("toast")).toContainText("left to review");
});

test("review: the card names the event's day and time, and the panel's answers aren't cut short", async ({ page }) => {
  await page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, { calendars: CALS,
    events: [ev("gym", "primary", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00")] });
  await open(page);
  await page.keyboard.press("r");
  const card = page.getByTestId("recon-pill");
  await expect(card).toContainText("Did this happen?");
  await expect(card.locator(".review-when")).toHaveText(/Tue Oct 13 · 5\s?–\s?6 PM/);
  await expect(card.getByTestId("recon-btn-no")).toContainText("Didn't happen");
  await page.keyboard.press("Escape");
  await page.locator(".chip-timed", { hasText: "Gym" }).first().click({ position: { x: 6, y: 6 } });
  const row = page.getByTestId("panel-recon");
  await expect(row).toContainText("Did it happen?");
  await expect(row.getByRole("radio", { checked: true })).toHaveCount(0);
  for (const id of ["panel-recon-yes", "panel-recon-canceled", "panel-recon-no"]) {
    const fits = await row.getByTestId(id).evaluate((b) => b.scrollWidth <= b.clientWidth);
    expect(fits, `${id} label overflows its button`).toBe(true);
  }
  await expect(row.getByTestId("panel-recon-no")).toHaveText(/Didn't happen/);
  await row.getByTestId("panel-recon-canceled").click();
  await expect(row.getByTestId("panel-recon-canceled")).toHaveAttribute("aria-checked", "true");
  // the caption stays one line whatever the answer
  expect(await row.locator(".recon-q").evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(24);
});
