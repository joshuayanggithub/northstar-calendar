// Everyday panel editing: what Save sends, what Undo restores, and what
// Enter does. Found by the 2026-10-18 bug-finder pass.
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t }).first();
const panel = (page: Page) => page.getByTestId("event-panel");
const stored = (page: Page, summary: string) => page.evaluate(async (s) =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
    .filter((e: any) => e.summary === s), summary);
const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const evt = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const fixture = (page: Page, fx: unknown) => page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, fx);

test("panel: an end time picked past midnight keeps the listed duration", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("late", "primary", "Late call", "2026-10-14T22:00:00-04:00", "2026-10-14T23:00:00-04:00")] });
  await open(page);
  await chip(page, "Late call").click();
  const p = panel(page);
  await p.getByTestId("time-end").focus();
  const opt = p.locator("[data-testid=time-pop] .time-opt").filter({ has: page.locator(".time-opt-sub", { hasText: /^2h$/ }) });
  await expect(opt).toContainText("12 AM");
  await opt.dispatchEvent("pointerdown");
  await expect(p.locator(".panel-dur")).toContainText("2h");
  await p.getByRole("button", { name: /^Save/ }).click();
  const [ev] = await stored(page, "Late call");
  expect(new Date(ev.end).getTime() - new Date(ev.start).getTime()).toBe(2 * 3600_000);
});

test("panel: an overnight end picked back before midnight is a same-day end", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("late", "primary", "Late call", "2026-10-14T23:00:00-04:00", "2026-10-15T01:00:00-04:00")] });
  await open(page);
  await chip(page, "Late call").click();
  const p = panel(page);
  await p.getByTestId("time-end").focus();
  await p.locator("[data-testid=time-pop] .time-opt").filter({ has: page.locator(".time-opt-sub", { hasText: /^30min$/ }) })
    .dispatchEvent("pointerdown");
  await p.getByRole("button", { name: /^Save/ }).click();
  const [ev] = await stored(page, "Late call");
  expect(new Date(ev.end).getTime() - new Date(ev.start).getTime()).toBe(30 * 60_000);
});

test("panel: Save keeps fields that changed remotely while the panel was open", async ({ page }) => {
  await open(page);
  await chip(page, "Standup").click();
  const p = panel(page);
  await page.evaluate(async () => {
    const be = (window as any).__mockBackend;
    const ev = (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).find((e: any) => e.summary === "Standup");
    await be.updateEvent(ev.id, { ...ev, location: "Room 4B", description: "Agenda: Q4" }, ev.calendar_id);
  });
  await p.locator(".panel-title").fill("Standup v2");
  await p.getByRole("button", { name: /^Save/ }).click();
  const [ev] = await stored(page, "Standup v2");
  expect(ev.location).toBe("Room 4B");
  expect(ev.description).toBe("Agenda: Q4");
});

test("panel: Cmd+Z with the panel open is not undone by the next Save", async ({ page }) => {
  await open(page);
  await chip(page, "Standup").click();
  await panel(page).locator(".panel-title").fill("Standup renamed");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await chip(page, "Standup renamed").click();
  await page.locator(".panel-kind").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page, "Standup")).length).toBe(1);
  await panel(page).getByTestId("loc-input").fill("Zoom");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => (await stored(page, "Standup"))[0]?.location).toBe("Zoom");
  expect(await stored(page, "Standup renamed")).toHaveLength(0);
});

test("panel: undoing a Save keeps a note added in the same panel", async ({ page }) => {
  await open(page);
  await chip(page, "Gym").click();
  const p = panel(page);
  await p.getByTestId("drill-add").click();
  await p.getByTestId("drill-input").fill("felt strong");
  await p.getByTestId("drill-input").press("Enter");
  await expect.poll(async () => (await stored(page, "Gym"))[0]?.description).toContain("felt strong");
  await p.locator(".panel-title").fill("Gym (legs)");
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect(p).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page, "Gym")).length).toBe(1);
  expect((await stored(page, "Gym"))[0].description).toContain("felt strong");
});

test("panel: cancelling the recurring scope dialog returns to the edited panel", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) }).first().click();
  const p = panel(page);
  await p.locator(".panel-title").fill("Sleep (early)");
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByTestId("scope-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(p).toBeVisible();
  await expect(p.locator(".panel-title")).toHaveValue("Sleep (early)");
});

test("panel: Copy to my calendar keeps the copy open when the refetch lags", async ({ page }) => {
  await fixture(page, {
    calendars: [PRIMARY, { ...PRIMARY, id: "school", summary: "School", is_primary: false, access_role: "reader" }],
    events: [evt("lec", "school", "Lecture", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00")],
  });
  await open(page);
  await chip(page, "Lecture").click();
  const p = panel(page);
  await p.getByTestId("panel-copy").click();
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    const o = be.listEvents.bind(be);
    be.listEvents = async (...a: any[]) => { await new Promise((r) => setTimeout(r, 50)); return o(...a); };
  });
  await p.getByTestId("copy-target").filter({ hasText: "Personal" }).click();
  await page.waitForTimeout(400);
  await expect(p.getByTestId("panel-cal-trigger")).toContainText("Personal");
});

test("panel: Enter twice during a slow create makes one event", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    const o = be.createEvent.bind(be);
    be.createEvent = async (i: any) => { await new Promise((r) => setTimeout(r, 300)); return o(i); };
  });
  const box = (await page.getByTestId("day-col-4").boundingBox())!;
  const y = box.y + 13 * 48 + 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y + 48, { steps: 6 });
  await page.mouse.up();
  await panel(page).locator(".panel-title").fill("Deep work");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await stored(page, "Deep work")).toHaveLength(1);
});

test("panel: Enter on the focused Delete button deletes", async ({ page }) => {
  await open(page);
  await chip(page, "Client prep").click();
  await panel(page).locator(".panel-footer").getByRole("button", { name: "Delete" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await stored(page, "Client prep")).length).toBe(0);
});

test("panel: Enter on the focused All-day button toggles it", async ({ page }) => {
  await open(page);
  await chip(page, "Client prep").click();
  const allDay = panel(page).getByRole("button", { name: "All-day" });
  await allDay.focus();
  await page.keyboard.press("Enter");
  await expect(allDay).toHaveClass(/on/);
});

test("panel: Save keeps busy/free and the reminder changed remotely while open", async ({ page }) => {
  await open(page);
  await chip(page, "Standup").click();
  const p = panel(page);
  await page.evaluate(async () => {
    const be = (window as any).__mockBackend;
    const ev = (await be.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).find((e: any) => e.summary === "Standup");
    await be.updateEvent(ev.id, { ...ev, transparency: "transparent", reminder_minutes: 30 }, ev.calendar_id);
  });
  await p.locator(".panel-title").fill("Standup v3");
  await p.getByRole("button", { name: /^Save/ }).click();
  const [ev] = await stored(page, "Standup v3");
  expect(ev.raw?.transparency).toBe("transparent");
  expect(ev.raw?.reminders?.overrides?.[0]?.minutes).toBe(30);
});

// ---- Save with nothing edited writes nothing (found on real data, run 2)

const CAL = { id: "p", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const pev = (id: string, summary: string, start: string, end: string, x: Record<string, unknown> = {}) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end, all_day: false, timezone: null,
  status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...x,
});
const storedAll = (page: Page) => page.evaluate(async () =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")));
async function saveUnchanged(page: Page, t: string) {
  await page.locator(".chip-timed", { hasText: t }).first().click();
  await page.getByTestId("event-panel").getByRole("button", { name: /^Save/ }).click();
}

test("panel: Save with no edits keeps a noted description byte for byte", async ({ page }) => {
  const desc = "[DRILL] **[Red marker scribble in margin]**  Bed by   11.\n\nAgenda line\n";
  await fixture(page, { calendars: [CAL], events: [pev("a", "Review", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00", { description: desc })] });
  await open(page);
  await saveUnchanged(page, "Review");
  await page.waitForTimeout(300);
  expect((await storedAll(page))[0].description).toBe(desc);
});

test("panel: an edit to another field keeps a noted description as stored", async ({ page }) => {
  const desc = "Agenda line\n\n[DRILL] Bed by 11.\n";
  await fixture(page, { calendars: [CAL], events: [pev("a", "Review", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00", { description: desc })] });
  await open(page);
  await chip(page, "Review").click();
  await panel(page).getByTestId("loc-input").fill("Room 2");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => (await storedAll(page))[0].location).toBe("Room 2");
  expect((await storedAll(page))[0].description).toBe(desc);
});

test("panel: Save with no edits keeps an event's seconds", async ({ page }) => {
  await fixture(page, { calendars: [CAL], events: [pev("b", "Imported", "2026-10-14T13:15:23-04:00", "2026-10-14T14:01:50-04:00")] });
  await open(page);
  await saveUnchanged(page, "Imported");
  await page.waitForTimeout(300);
  const [e] = await storedAll(page);
  expect([Date.parse(e.start), Date.parse(e.end)]).toEqual([Date.parse("2026-10-14T13:15:23-04:00"), Date.parse("2026-10-14T14:01:50-04:00")]);
});

test("panel: Save with no edits on a recurring occurrence asks nothing and writes nothing", async ({ page }) => {
  const s = (d: number) => pev(`r${d}`, "Lift", `2026-10-${d}T18:00:00-04:00`, `2026-10-${d}T19:00:00-04:00`, { recurring_event_id: "m" });
  await fixture(page, { calendars: [CAL], events: [s(12), s(13), s(14), s(15), s(16)] });
  await open(page);
  const before = JSON.stringify(await storedAll(page));
  await page.getByTestId("day-col-3").locator(".chip-timed", { hasText: "Lift" }).click();
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId("scope-dialog")).toHaveCount(0);
  expect(JSON.stringify(await storedAll(page))).toBe(before);
});

test("cut and paste of a read-only event doesn't invite its guests", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY, { id: "team", summary: "Team", color: "#e8a13c", is_primary: false, hidden: false, access_role: "reader" }], events: [
    { ...evt("ro1", "team", "Boss sync", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"),
      raw: { attendees: [{ email: "boss@corp.com", organizer: true, responseStatus: "accepted" }, { email: "ann@corp.com", responseStatus: "accepted" }] } } ] });
  await open(page);
  await chip(page, "Boss sync").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await page.waitForTimeout(300);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await stored(page, "Boss sync")).length).toBe(2);
  const copy = (await stored(page, "Boss sync")).find((e: any) => e.calendar_id === "primary");
  expect(copy.raw?.attendees ?? []).toEqual([]);
});

test("cut and paste of someone else's invitation doesn't invite their guests or take their Meet", async ({ page }) => {
  const conf = { conferenceId: "abc-defg-hij", conferenceSolution: { key: { type: "hangoutsMeet" } }, entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] };
  await fixture(page, { calendars: [PRIMARY], events: [{
    ...evt("inv", "primary", "Boss 1:1", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"),
    conference_url: conf.entryPoints[0].uri,
    raw: { organizer: { email: "boss@corp.com" }, conferenceData: conf, attendees: [
      { email: "boss@corp.com", organizer: true, responseStatus: "accepted" },
      { email: "me@example.com", self: true, responseStatus: "accepted" },
      { email: "carol@corp.com", responseStatus: "declined" }] },
  }] });
  await open(page);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    (window as any).__creates = [];
    const c = be.createEvent.bind(be);
    be.createEvent = async (i: any) => { (window as any).__creates.push(i); return c(i); };
  });
  await chip(page, "Boss 1:1").click({ position: { x: 6, y: 6 } }); // (not its Join link)
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect.poll(async () => (await stored(page, "Boss 1:1")).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => page.evaluate(() => (window as any).__creates.length)).toBe(1);
  const [create] = await page.evaluate(() => (window as any).__creates);
  expect(create.attendee_details ?? []).toEqual([]);
  expect(create.conference_data ?? null).toBeNull();
});

test("one cut pasted twice puts the meeting on guests' calendars once", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [{
    ...evt("mine", "primary", "Team sync", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"),
    raw: { organizer: { email: "me@example.com", self: true }, attendees: [{ email: "carol@corp.com", responseStatus: "accepted" }] },
  }] });
  await open(page);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    (window as any).__creates = [];
    const c = be.createEvent.bind(be);
    be.createEvent = async (i: any) => { (window as any).__creates.push(i); return c(i); };
  });
  await chip(page, "Team sync").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect.poll(async () => (await stored(page, "Team sync")).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => page.evaluate(() => (window as any).__creates.length)).toBe(2);
  const guests = await page.evaluate(() => (window as any).__creates.map((i: any) => (i.attendee_details ?? []).map((a: any) => a.email)));
  expect(guests).toEqual([["carol@corp.com"], []]);
});

// ---- a cut whose original stays (undone, or its delete cancelled) pastes as a copy

const spyCreates = (page: Page) => page.evaluate(() => {
  const be = (window as any).__mockBackend;
  (window as any).__creates = [];
  const c = be.createEvent.bind(be);
  be.createEvent = async (i: any) => { (window as any).__creates.push(i); return c(i); };
});
const mineWithGuest = { organizer: { email: "me@example.com", self: true }, attendees: [{ email: "carol@corp.com", responseStatus: "accepted" }] };

test("cut, undo, paste: the paste is a copy and doesn't re-invite the guests", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [{
    ...evt("mine", "primary", "Team sync", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"), raw: mineWithGuest }] });
  await open(page);
  await spyCreates(page);
  await chip(page, "Team sync").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect.poll(async () => (await stored(page, "Team sync")).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page, "Team sync")).length).toBe(1);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await stored(page, "Team sync")).length).toBe(2);
  const guests = await page.evaluate(() => (window as any).__creates.map((i: any) => (i.attendee_details ?? []).map((a: any) => a.email)));
  expect(guests).toEqual([["carol@corp.com"], []]); // undo's re-create keeps carol; the copy must not
});

test("cut a recurring occurrence, cancel the scope dialog, paste: no second invitation", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [{
    ...evt("r14", "primary", "Weekly sync", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00"),
    recurring_event_id: "m", raw: mineWithGuest }] });
  await open(page);
  await spyCreates(page);
  await chip(page, "Weekly sync").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await page.getByTestId("scope-dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("scope-dialog")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => page.evaluate(() => (window as any).__creates.length)).toBe(1);
  const [create] = await page.evaluate(() => (window as any).__creates);
  expect((create.attendee_details ?? []).map((a: any) => a.email)).toEqual([]);
});

// ---- found by the run-3 panel bug hunt (each failed before its fix)

test("panel: the duration label stays inside the panel and the panel never scrolls sideways", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("g", "primary", "Gym", "2026-10-14T17:00:00-04:00", "2026-10-14T18:30:00-04:00")] });
  await open(page);
  await chip(page, "Gym").click();
  const p = panel(page);
  await expect(p.locator(".panel-dur")).toHaveText("1h 30min");
  const m = await p.evaluate((el) => ({
    durRight: el.querySelector(".panel-dur")!.getBoundingClientRect().right,
    contentRight: el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight),
    scrollW: el.scrollWidth, clientW: el.clientWidth,
  }));
  expect(m.durRight).toBeLessThanOrEqual(m.contentRight);
  expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
  await p.getByTestId("time-end").focus();
  await page.waitForTimeout(200);
  expect(await p.evaluate((el) => el.scrollLeft)).toBe(0);
});

test("panel: a typed end time past midnight is the next day's", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("late", "primary", "Late call", "2026-10-14T22:00:00-04:00", "2026-10-14T23:00:00-04:00")] });
  await open(page);
  await chip(page, "Late call").click();
  const p = panel(page);
  await p.getByTestId("time-end").fill("00:30"); // typed, not picked from the list
  await expect(p.locator(".panel-dur")).toContainText("2h 30min");
  await p.getByRole("button", { name: /^Save/ }).click();
  const [ev] = await stored(page, "Late call");
  expect(new Date(ev.end).getTime() - new Date(ev.start).getTime()).toBe(2.5 * 3600_000);
});

test("panel: a typed same-evening end on an overnight event drops the +1d", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("sl", "primary", "Sleep", "2026-10-14T23:00:00-04:00", "2026-10-15T07:00:00-04:00")] });
  await open(page);
  await chip(page, "Sleep").click();
  await panel(page).getByTestId("time-end").fill("23:30");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  const [ev] = await stored(page, "Sleep");
  expect(new Date(ev.end).getTime() - new Date(ev.start).getTime()).toBe(30 * 60_000); // was 24h 30min
});

test("panel: All-day switched off on one event doesn't shape the next event made all-day", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [
    evt("r", "primary", "Retreat", "2026-10-13", "2026-10-16", { all_day: true }),
    evt("s", "primary", "Standup", "2026-10-14T09:00:00-04:00", "2026-10-14T10:00:00-04:00"),
  ] });
  await open(page);
  await page.locator(".chip-allday", { hasText: "Retreat" }).first().click();
  await panel(page).getByRole("button", { name: "All-day" }).click(); // off (9–10), not saved
  await page.keyboard.press("Escape");
  await chip(page, "Standup").click();
  await panel(page).getByRole("button", { name: "All-day" }).click();
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => { const [e] = await stored(page, "Standup"); return [e.start, e.end]; })
    .toEqual(["2026-10-14", "2026-10-15"]); // was 10-14 → 10-16
});

test("panel: the end-time list opens at the current end of an overnight event", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("sl", "primary", "Sleep", "2026-10-14T23:00:00-04:00", "2026-10-15T07:00:00-04:00")] });
  await open(page);
  await chip(page, "Sleep").click();
  await panel(page).getByTestId("time-end").focus();
  const pop = panel(page).getByTestId("time-pop");
  await expect(pop.locator(".time-opt.active")).toHaveText(/7 AM/);
  await expect(pop.locator(".time-opt.active")).toBeInViewport();
});

test("panel: a double-clicked Delete in the ⋯ menu deletes once (two undos don't duplicate)", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("a", "primary", "Review", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00")] });
  await open(page);
  await page.evaluate(() => {
    const be = (window as any).__mockBackend;
    (window as any).__deletes = 0;
    const o = be.deleteEvent.bind(be);
    be.deleteEvent = async (...a: any[]) => { (window as any).__deletes++; await new Promise((r) => setTimeout(r, 200)); return o(...a); };
  });
  await chip(page, "Review").click();
  await panel(page).getByRole("button", { name: "More actions" }).click();
  await panel(page).getByTestId("panel-menu").getByRole("button", { name: "Delete" }).dblclick();
  await expect.poll(async () => (await stored(page, "Review")).length).toBe(0);
  expect(await page.evaluate(() => (window as any).__deletes)).toBe(1);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await stored(page, "Review")).length).toBe(1);
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(300);
  expect(await stored(page, "Review")).toHaveLength(1); // was 2
});

test("panel: a repeat rule picked for a new event lights the Repeat pill", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [] });
  await open(page);
  const box = (await page.getByTestId("day-col-4").boundingBox())!;
  const y = box.y + 13 * 48 + 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y + 48, { steps: 6 });
  await page.mouse.up();
  const p = panel(page);
  await p.locator("select.panel-repeat").selectOption("RRULE:FREQ=WEEKLY");
  await expect(p.locator("select.panel-repeat")).toHaveClass(/on/);
  await p.getByRole("button", { name: "All-day" }).click();
  const color = (l: ReturnType<typeof p.locator>) => l.evaluate((e) => getComputedStyle(e).color);
  expect(await color(p.locator("select.panel-repeat"))).toBe(await color(p.getByRole("button", { name: "All-day" })));
});

test("panel: the pills in one row share one size", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("a", "primary", "Review", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00")] });
  await open(page);
  await chip(page, "Review").click();
  const sizes = await panel(page).locator(".panel-link").evaluateAll((els) => els.map((e) => `${getComputedStyle(e).fontSize}/${Math.round(e.getBoundingClientRect().height)}`));
  expect(new Set(sizes).size).toBe(1); // was {"11.5px/19", "12px/21"}
});

test("panel: Tab from the start time reaches the end time without dropping focus", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("a", "primary", "Review", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00")] });
  await open(page);
  await chip(page, "Review").click();
  await panel(page).getByTestId("time-start").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab"); // hour, minute, AM/PM, out
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid)).toBe("time-end"); // was undefined (body)
});

test("panel: the ⋯ menu closes when clicking into the title", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("a", "primary", "Review", "2026-10-14T13:00:00-04:00", "2026-10-14T14:00:00-04:00")] });
  await open(page);
  await chip(page, "Review").click();
  await panel(page).getByRole("button", { name: "More actions" }).click();
  await panel(page).locator(".panel-title").click({ position: { x: 20, y: 10 } });
  await expect(panel(page).getByTestId("panel-menu")).toHaveCount(0);
});

test("panel: a read-only event shows no empty footer and no clickable-looking disabled pill", async ({ page }) => {
  const RO = { id: "school", summary: "School", color: "#e8a13c", is_primary: false, hidden: false, access_role: "reader" };
  await fixture(page, { calendars: [PRIMARY, RO], events: [evt("lec", "school", "Lecture", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00")] });
  await open(page);
  await chip(page, "Lecture").click();
  const p = panel(page);
  await expect(p.getByTestId("panel-readonly")).toBeVisible();
  await expect(p.locator(".panel-footer")).toBeHidden(); // was: an empty 13px bar with a top border
  await expect(p.getByRole("button", { name: "All-day" })).toBeDisabled();
  expect(await p.getByRole("button", { name: "All-day" }).evaluate((e) => getComputedStyle(e).cursor)).not.toBe("pointer");
});
