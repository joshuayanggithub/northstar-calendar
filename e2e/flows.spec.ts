// Notes, RSVP and cut/copy/paste/undo flows: found by the 2026-10-19
// bug-finder pass (each failed before its fix).
import { expect, test, type Locator, type Page } from "@playwright/test";

const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const evt = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const fixture = (page: Page, fx: unknown) => page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, fx);
async function open(page: Page, now = "2026-10-14T09:00:00") {
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t }).first();
const panel = (page: Page) => page.getByTestId("event-panel");
const stored = (page: Page, s: string) => page.evaluate(async (s) => (await (window as any).__mockBackend
  .listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).filter((e: any) => e.summary === s), s);
async function dragBy(page: Page, loc: Locator, dx: number, dy: number) {
  const b = (await loc.boundingBox())!; const x = b.x + b.width / 2, y = b.y + Math.min(10, b.height / 2);
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 10 }); await page.mouse.up();
}
function occ(m: string, summary: string, day: number, rules: string[], hour = 9) {
  const date = `2026-10-${String(day).padStart(2, "0")}`; const hh = (h: number) => String(h).padStart(2, "0");
  const start = `${date}T${hh(hour)}:00:00-04:00`;
  return { ...evt(`${m}_${date.replace(/-/g, "")}`, "primary", summary, start, `${date}T${hh(hour + 1)}:00:00-04:00`),
    recurring_event_id: m, raw: { masterRecurrence: rules, originalStartTime: { dateTime: start } } };
}

const conf = { conferenceId: "abc-defg-hij", conferenceSolution: { key: { type: "hangoutsMeet" } }, entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] };
const MINE = { ...evt("mine", "primary", "Team sync", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"), conference_url: conf.entryPoints[0].uri,
  raw: { organizer: { email: "me@example.com", self: true }, conferenceData: conf, transparency: "transparent",
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    attendees: [{ email: "me@example.com", self: true, organizer: true, responseStatus: "accepted" }, { email: "carol@corp.com", responseStatus: "accepted" }] } };
const summary = (e: any) => ({ meet: e.conference_url, busy: e.raw?.transparency, reminder: e.raw?.reminders?.overrides?.[0]?.minutes ?? null,
  guests: (e.raw?.attendees ?? []).map((a: any) => a.email).sort() });

test("right-click Cut then ⌘V keeps Meet, guests, reminder, busy/free like ⌘X", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [MINE] });
  await open(page);
  await chip(page, "Team sync").click({ button: "right", position: { x: 6, y: 6 } });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /^Cut/ }).click();
  await expect.poll(async () => (await stored(page, "Team sync")).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await stored(page, "Team sync")).length).toBe(1);
  expect(summary((await stored(page, "Team sync"))[0])).toEqual(summary(MINE));
});

test("undoing a recurring occurrence's move keeps a later remote title change", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [13, 14, 15].map((d) => occ("su", "Standup", d, ["RRULE:FREQ=DAILY;COUNT=3"])) });
  await open(page, "2026-10-14T08:00:00");
  await dragBy(page, page.locator('[data-ek="primary/su_20261014"]').first(), 0, 48);
  await page.getByTestId("scope-dialog").getByTestId("scope-this").click();
  await expect.poll(async () => (await stored(page, "Standup")).find((e: any) => e.id === "su_20261014")?.start).toContain("T10:00");
  await page.evaluate(async () => {
    const be = (window as any).__mockBackend;
    const e = (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).find((r: any) => r.id === "su_20261014");
    await be.updateEvent(e.id, { ...e, summary: "Standup (remote)", description: "added remotely" }, e.calendar_id);
  });
  await expect(page.locator(".chip-timed", { hasText: "Standup (remote)" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page, "Standup (remote)"))[0]?.start).toContain("T09:00");
  expect((await stored(page, "Standup (remote)"))[0].description).toBe("added remotely");
});

test("⌘Z twice after deleting a series doesn't revert an unrelated earlier edit", async ({ page }) => {
  const lunch = evt("lunch", "primary", "Lunch", "2026-10-14T12:00:00-04:00", "2026-10-14T13:00:00-04:00");
  await fixture(page, { calendars: [PRIMARY], events: [...[13, 14, 15].map((d) => occ("su", "Standup", d, ["RRULE:FREQ=DAILY;COUNT=3"])), lunch] });
  await open(page, "2026-10-14T08:00:00");
  await chip(page, "Lunch").click();
  await panel(page).locator(".panel-title").fill("Lunch with Ana");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect(chip(page, "Lunch with Ana")).toHaveCount(1);
  await page.locator('[data-ek="primary/su_20261014"]').first().click();
  await panel(page).getByRole("button", { name: /Delete/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toContainText("Can't undo");
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(400);
  await expect(page.getByTestId("toast")).toContainText("Can't undo");
  expect((await stored(page, "Lunch with Ana")).length, "the second ⌘Z reverted the Lunch rename").toBe(1);
});

const TEAM = { id: "team", summary: "Ann (shared)", color: "#e8a13c", is_primary: false, hidden: false, access_role: "reader" };
const SHARED_INV = evt("ann_inv", "team", "Budget review", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00", { raw: {
  organizer: { email: "boss@corp.com" },
  attendees: [{ email: "boss@corp.com", organizer: true, responseStatus: "accepted" }, { email: "ann@corp.com", self: true, responseStatus: "needsAction" }] } });
test("an invitation on a read-only shared calendar offers no Going? bar and no reply is sent", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY, TEAM], events: [SHARED_INV] });
  await open(page);
  await page.evaluate(() => { const be = (window as any).__mockBackend; (window as any).__replies = [];
    const o = be.respondEvent.bind(be); be.respondEvent = (...a: any[]) => { (window as any).__replies.push(a); return o(...a); }; });
  await chip(page, "Budget review").click({ position: { x: 6, y: 6 } });
  await expect(panel(page).getByTestId("guest-row").filter({ hasText: "ann@corp.com" })).not.toContainText("You");
  const bar = panel(page).getByTestId("rsvp");
  if (await bar.count()) await bar.getByRole("button", { name: "Yes" }).click();
  await page.waitForTimeout(300);
  await expect(bar).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__replies)).toEqual([]);
});

test("⌘D of a noted event doesn't put the note on the duplicate", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("gym", "primary", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00", { description: "Leg day\n\n[DRILL] felt strong" })] });
  await open(page);
  await chip(page, "Gym").click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+d");
  await expect.poll(async () => (await stored(page, "Gym")).length).toBe(2);
  expect((await stored(page, "Gym")).filter((e: any) => /\[DRILL\]/.test(e.description ?? ""))).toHaveLength(1);
  await expect(page.locator(".margin-note").filter({ hasText: "felt strong" })).toHaveCount(1);
});

const INV = (me: string) => ({ organizer: { email: "prof@example.edu" }, attendees: [
  { email: "prof@example.edu", organizer: true, responseStatus: "accepted" }, { email: "me@example.edu", self: true, responseStatus: me }] });
test("list view shows a declined invitation struck through like week and month", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [
    evt("party", "primary", "Lab party", "2026-10-16T10:00:00-04:00", "2026-10-16T11:00:00-04:00", { raw: INV("declined") }),
    evt("staff", "primary", "Course staff", "2026-10-15T10:00:00-04:00", "2026-10-15T11:00:00-04:00", { raw: INV("needsAction") }) ] });
  await open(page);
  await page.keyboard.press("l");
  const row = page.locator(".agenda-row", { hasText: "Lab party" });
  await expect(row).toHaveClass(/invite-declined/);
  await expect(row.locator(".agenda-title")).toHaveCSS("text-decoration-line", "line-through");
});
