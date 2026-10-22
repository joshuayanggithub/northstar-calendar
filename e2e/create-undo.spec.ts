// Creating events and undo: found by the 2026-10-21 run 5 bug-finder (each
// failed before its fix).
import { expect, test, type Page } from "@playwright/test";

const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const WORK = { id: "work", summary: "Work", color: "#2fbf71", is_primary: false, hidden: false, access_role: "owner" };
const evt = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
async function open(page: Page, fx: unknown, now = "2026-10-14T09:00:00") {
  await page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, fx);
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const rows = (page: Page) => page.evaluate(async () =>
  await (window as any).__mockBackend.listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"));
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t }).first();
/** the native backend is an IPC round trip, not a microtask: give the mock one */
const slow = (page: Page, method: "createEvent" | "deleteEvent", ms = 150) => page.evaluate(([m, ms]) => {
  const be = (window as any).__mockBackend;
  const orig = be[m];
  be[m] = async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, ms as number)); return orig(...a); };
}, [method, ms] as const);
async function quick(page: Page, text: string) {
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-create")).toHaveCount(0);
}

test("undo: a group move's undo keeps a title changed after the move", async ({ page }) => {
  await open(page, { calendars: [PRIMARY], events: [
    evt("a", "primary", "Alpha", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00"),
    evt("b", "primary", "Bravo", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"),
  ] });
  await chip(page, "Alpha").click({ modifiers: ["Shift"] });
  await chip(page, "Bravo").click({ modifiers: ["Shift"] });
  const b = (await chip(page, "Alpha").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 10 + 96, { steps: 10 }); // +2h
  await page.mouse.up();
  await expect.poll(async () => (await rows(page)).find((r: any) => r.id === "b").start).toBe("2026-10-14T15:00:00-04:00");
  // a sync pull renames Bravo (someone else edited it on Google)
  await page.evaluate(async () => {
    const be = (window as any).__mockBackend;
    const r = (await be.listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).find((x: any) => x.id === "b");
    await be.updateEvent("b", { ...r, summary: "Bravo (moved to Thu)" });
  });
  await expect(chip(page, "Bravo (moved to Thu)")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await rows(page)).find((r: any) => r.id === "b").start).toBe("2026-10-14T13:00:00-04:00");
  // got: "Bravo" — the group undo rewrote the whole pre-move snapshot
  expect((await rows(page)).find((r: any) => r.id === "b").summary).toBe("Bravo (moved to Thu)");
});

test("undo: double-clicking the toast's Undo takes back one change, not two", async ({ page }) => {
  await open(page, { calendars: [PRIMARY], events: [] });
  await quick(page, "alpha tomorrow 9am");
  await quick(page, "beta tomorrow 11am");
  await expect(page.getByTestId("toast")).toContainText("beta");
  await slow(page, "deleteEvent");
  await page.locator(".toast-undo").dblclick();
  await expect(page.getByTestId("toast")).toContainText("Undid");
  await page.waitForTimeout(500);
  // got: [] — the second click reached "Created alpha" under it
  expect((await rows(page)).map((r: any) => r.summary)).toEqual(["alpha"]);
});

test("quick create: Enter pressed twice creates one event", async ({ page }) => {
  await open(page, { calendars: [PRIMARY], events: [] });
  await slow(page, "createEvent");
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill("lunch tomorrow 12pm");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quick-create")).toHaveCount(0);
  await page.waitForTimeout(500);
  // got: 2 rows "lunch" (the editor guards this with savingRef; quick create doesn't)
  expect((await rows(page)).map((r: any) => r.summary)).toEqual(["lunch"]);
});

test("quick create: with a calendar isolated, the event goes to that calendar", async ({ page }) => {
  await open(page, { calendars: [PRIMARY, WORK], events: [evt("w", "work", "Standup", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00")] });
  await page.getByTestId("cal-row").filter({ hasText: "Work" }).click({ button: "right" });
  await page.getByTestId("cal-menu").getByRole("button", { name: "Isolate calendar" }).click();
  await expect(page.getByTestId("isolate-pill")).toBeVisible();
  await quick(page, "review tomorrow 2pm");
  await expect.poll(async () => (await rows(page)).length).toBe(2);
  // got: "primary" — created on Personal and invisible in the isolated view
  // (⌘N's editor already defaults to the isolated calendar)
  expect((await rows(page)).find((r: any) => r.summary === "review").calendar_id).toBe("work");
  await expect(chip(page, "review")).toBeVisible();
});

test("duplicate: ⌥-drag copy leaves the red-pen note on the original (as ⌘D does)", async ({ page }) => {
  await open(page, { calendars: [PRIMARY], events: [
    evt("a", "primary", "Essay", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00", { description: "outline\n\n[DRILL] went long" }),
  ] });
  const b = (await chip(page, "Essay").boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(b.x + 20, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + 20, b.y + 8 + 96, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await rows(page)).length).toBe(2);
  const copy = (await rows(page)).find((r: any) => r.id !== "a");
  // got: "outline\n\n[DRILL] went long", and two "went long" notes in the margin
  expect(copy.description).toBe("outline");
});

test("editor: Weekdays picked for a Saturday draft starts the series on Monday", async ({ page }) => {
  await open(page, { calendars: [PRIMARY], events: [] }, "2026-10-17T09:00:00"); // Saturday
  await page.keyboard.press("ControlOrMeta+n");
  const p = page.getByTestId("event-panel");
  await p.getByPlaceholder("Title").fill("standup");
  await p.locator("select.panel-repeat").selectOption({ label: "Weekdays" });
  await p.getByRole("button", { name: /^Create/ }).click();
  await expect.poll(async () => (await rows(page)).length).toBe(1);
  const [ev] = await rows(page);
  expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]);
  // got: "Sat" (2026-10-17T14:00Z) — Google keeps DTSTART as an extra Saturday
  // occurrence; quick create's "every weekday" already moves to Monday
  expect(new Date(ev.start).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" })).toBe("Mon");
});
