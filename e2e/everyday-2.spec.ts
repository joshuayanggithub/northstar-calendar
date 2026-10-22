// Selection, undo, list/insights and panel fields: found by the 2026-10-18
// bug-finder pass, round 3 (each failed before its fix).
import { expect, test, type Locator, type Page } from "@playwright/test";

async function open(page: Page, now = "2026-10-14T09:00:00") {
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
}
const backendEvents = (page: Page, s: string) => page.evaluate(async (s) => (await (window as any).__mockBackend
  .listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).filter((e: any) => e.summary === s), s);
async function dragBy(page: Page, loc: Locator, dx: number, dy: number) {
  const b = (await loc.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + Math.min(10, b.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}
const PRIMARY = { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" };
const WORK = { id: "work", summary: "Work", color: "#2fbf71", is_primary: false, hidden: false, access_role: "owner" };
const evt = (id: string, cal: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: cal, etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const fixture = (page: Page, fx: unknown) => page.addInitScript((f) => { (globalThis as any).__calFixture = f; }, fx);
const panel = (page: Page) => page.getByTestId("event-panel");
const chip = (page: Page, t: string) => page.locator(".chip-timed", { hasText: t }).first();

// ---- selection

test("select: ⌘A then Delete only touches the week on screen", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  expect(await backendEvents(page, "Dentist")).toHaveLength(1); // Mon Oct 19, next week
});

test("select: n with nothing selected selects an event on screen", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j");
  await page.keyboard.press("n");
  await expect(page.locator(".chip.selected").first()).toBeInViewport();
});

test("select: x over a C-shape event adds it to the selection", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).click({ modifiers: ["Shift"] });
  const seg = page.locator('[data-testid="cshape-seg"]', { hasText: "Sleep" }).first();
  await seg.scrollIntoViewIfNeeded();
  await seg.hover({ position: { x: 4, y: 20 } });
  await page.keyboard.press("x");
  await expect(page.locator(".chip.selected")).toHaveCount(2);
});

test("select: a shift-clicked all-day event shows as selected", async ({ page }) => {
  await open(page);
  await page.locator(".chip-allday", { hasText: "Offsite" }).first().click({ modifiers: ["Shift"] });
  await expect(page.locator(".chip-allday.selected")).not.toHaveCount(0);
});

// ---- undo, ⌥-drag

test("undo: create → move → delete, undone three times, leaves no event", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create");
  await qc.locator("input").fill("coffee with alex friday 3pm");
  await qc.locator("input").press("Enter");
  const c = page.locator(".chip-timed", { hasText: "coffee with alex" });
  await expect(c).toBeVisible();
  await dragBy(page, c, 0, 48);
  await expect.poll(async () => (await backendEvents(page, "coffee with alex"))[0]?.start).toContain("16:00");
  await c.click({ modifiers: ["Shift"] });
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await backendEvents(page, "coffee with alex")).length).toBe(0);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(300);
  }
  expect(await backendEvents(page, "coffee with alex")).toHaveLength(0);
});

test("⌥-drag of a timed event onto the all-day lane copies it", async ({ page }) => {
  await open(page);
  const c = page.locator(".chip-timed", { hasText: "Morning run" });
  const lane = (await page.getByTestId("allday-row").boundingBox())!;
  const b = (await c.boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(b.x + b.width / 2, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, lane.y + lane.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await backendEvents(page, "Morning run")).length).toBe(2);
  expect((await backendEvents(page, "Morning run")).filter((e: any) => !e.all_day)).toHaveLength(1);
});

test("⌥-drag of an all-day event along the lane copies it", async ({ page }) => {
  await open(page);
  const c = page.locator(".chip-allday", { hasText: "Offsite" }).first();
  const before = await backendEvents(page, "Offsite");
  const col = (await page.getByTestId("day-col-4").boundingBox())!;
  await page.keyboard.down("Alt");
  await dragBy(page, c, col.width * 2, 0);
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await backendEvents(page, "Offsite")).length).toBe(before.length + 1);
  expect((await backendEvents(page, "Offsite")).map((e: any) => e.start)).toContain(before[0].start);
});

// ---- list, insights

test("list: shows only its 14-day period", async ({ page }) => {
  await open(page);
  await page.keyboard.press("l");
  await expect(page.locator(".agenda-day").first()).toBeVisible();
  await expect(page.locator(".agenda-day", { hasText: "Oct 11" })).toHaveCount(0);
});

test("list: an empty period says so", async ({ page }) => {
  await open(page);
  await page.keyboard.press("l");
  await page.keyboard.press("j");
  await expect(page.locator(".agenda-empty")).toBeVisible();
});

test("list: a day's events are in time order whatever their stored offset", async ({ page }) => {
  await open(page);
  const inp = { calendar_id: "primary", summary: "Pacific sync", start: "2026-10-14T08:30:00-07:00", end: "2026-10-14T09:00:00-07:00", all_day: false };
  await page.evaluate(async (i) => { const b = (window as any).__mockBackend; const id = await b.createEvent(i); await b.updateEvent(id, i); }, inp);
  await page.keyboard.press("l");
  const titles = await page.locator("section", { has: page.locator(".agenda-day", { hasText: "Today" }) }).locator(".agenda-title").allTextContents();
  expect(titles.indexOf("Pacific sync")).toBeGreaterThan(titles.indexOf("Standup"));
});

test("insights: no day doubled after the DST change", async ({ page }) => {
  await open(page, "2026-11-10T09:00:00");
  await page.keyboard.press("i");
  await expect(page.locator(".ins-cell").first()).toBeVisible();
  const t = await page.locator(".ins-cell").evaluateAll((els) => els.map((e) => e.getAttribute("title")!.split(":")[0]));
  expect(new Set(t).size).toBe(t.length);
});

// ---- panel fields

test("panel: a timed event moved earlier and made all-day is one day", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("r", "primary", "Review", "2026-10-16T10:00:00-04:00", "2026-10-16T11:00:00-04:00")] });
  await open(page);
  await chip(page, "Review").click();
  const p = panel(page);
  await p.locator(".panel-date-pretty").click();
  const date = p.locator('input[type="date"]:not(.allday-end)');
  await date.fill("2026-10-12");
  await date.blur();
  await p.getByRole("button", { name: "All-day" }).click();
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => { const [e] = await backendEvents(page, "Review"); return [e.start, e.end]; })
    .toEqual(["2026-10-12", "2026-10-13"]);
});

test("panel: a multi-day timed event made all-day keeps its days", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("c", "primary", "Conference", "2026-10-12T09:00:00-04:00", "2026-10-14T17:00:00-04:00")] });
  await open(page);
  await chip(page, "Conference").click();
  await panel(page).getByRole("button", { name: "All-day" }).click();
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => { const [e] = await backendEvents(page, "Conference"); return [e.start, e.end]; })
    .toEqual(["2026-10-12", "2026-10-15"]);
});

test("panel: clearing the date segment doesn't corrupt an all-day event", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("a", "primary", "Trip", "2026-10-14", "2026-10-16", { all_day: true })] });
  await open(page);
  await page.getByTestId("allday-row").getByRole("button", { name: "Trip" }).first().click();
  const p = panel(page);
  await p.locator(".panel-date-pretty").click();
  await page.keyboard.press("Backspace");
  await p.locator(".panel-title").click();
  await p.getByRole("button", { name: /^Save/ }).click();
  await page.waitForTimeout(300);
  expect((await backendEvents(page, "Trip"))[0].start).toBe("2026-10-14");
});

test("panel: moving one occurrence to another calendar isn't offered", async ({ page }) => {
  const inst = (id: string, d: string) => evt(id, "primary", "Weekly sync", `${d}T10:00:00-04:00`, `${d}T11:00:00-04:00`,
    { recurring_event_id: "ser", raw: { originalStartTime: { dateTime: `${d}T10:00:00-04:00` }, masterRecurrence: ["RRULE:FREQ=DAILY;COUNT=2"] } });
  await fixture(page, { calendars: [PRIMARY, WORK], events: [inst("ser_1", "2026-10-14"), inst("ser_2", "2026-10-15")] });
  await open(page);
  await chip(page, "Weekly sync").click();
  const p = panel(page);
  await p.getByTestId("panel-cal-trigger").click();
  await p.getByTestId("panel-cal-options").getByRole("option", { name: "Work" }).click();
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByTestId("scope-this")).toBeDisabled();
  await expect(page.getByTestId("scope-all")).toBeEnabled();
});

test("panel: a reminder outside the presets shows as itself", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("r", "primary", "Review", "2026-10-16T10:00:00-04:00", "2026-10-16T11:00:00-04:00",
    { raw: { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] } } })] });
  await open(page);
  await chip(page, "Review").click();
  const text = await panel(page).locator("select.panel-cal").evaluate((s: HTMLSelectElement) => s.selectedOptions[0]?.textContent ?? "");
  expect(text).toMatch(/15/);
});

test("panel: a Google HTML description reads as text, and is kept when untouched", async ({ page }) => {
  const html = 'Agenda<br>See <a href="https://docs.example.com/x">the doc</a>';
  await fixture(page, { calendars: [PRIMARY], events: [evt("r", "primary", "Review", "2026-10-16T10:00:00-04:00", "2026-10-16T11:00:00-04:00", { description: html })] });
  await open(page);
  await chip(page, "Review").click();
  await expect(panel(page).locator(".panel-desc")).toHaveValue("Agenda\nSee the doc (https://docs.example.com/x)");
  await panel(page).locator(".panel-title").fill("Review!");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => (await backendEvents(page, "Review!"))[0]?.description).toBe(html);
});

test("panel: a pasted guest list adds every guest", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("r", "primary", "Review", "2026-10-16T10:00:00-04:00", "2026-10-16T11:00:00-04:00")] });
  await open(page);
  await chip(page, "Review").click();
  const input = panel(page).locator(".panel-attendee-input");
  await input.fill("ann@example.com, bob@example.com, oops@example");
  await input.press("Enter");
  await expect(panel(page).getByTestId("guest-row")).toHaveCount(2);
  await expect(input).toHaveValue("oops@example");
});

test("undo: undoing a move keeps a later remote title change", async ({ page }) => {
  await open(page);
  await dragBy(page, page.locator(".chip-timed", { hasText: "Morning run" }), 0, 48);
  await expect.poll(async () => (await backendEvents(page, "Morning run"))[0]?.start).toContain("T08:00");
  const [ev] = await backendEvents(page, "Morning run");
  await page.evaluate(async (e) => (window as any).__mockBackend.updateEvent(e.id, { ...e, summary: "Morning run (remote)", description: "added remotely" }), ev);
  await expect(page.locator(".chip-timed", { hasText: "Morning run (remote)" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => {
    const start = (await backendEvents(page, "Morning run (remote)"))[0]?.start;
    return start && new Date(start).toISOString();
  }).toBe("2026-10-14T11:00:00.000Z"); // 7 AM EDT, where it was
  expect((await backendEvents(page, "Morning run (remote)"))[0].description).toBe("added remotely");
});

test("panel: ⌘Enter in the guests field saves, with the typed guest", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [evt("r", "primary", "Review", "2026-10-16T10:00:00-04:00", "2026-10-16T11:00:00-04:00")] });
  await open(page);
  await chip(page, "Review").click();
  await panel(page).locator(".panel-title").fill("Review w/ Ann");
  await panel(page).locator(".panel-attendee-input").fill("ann@example.com");
  await panel(page).locator(".panel-attendee-input").press("ControlOrMeta+Enter");
  await expect(panel(page)).toHaveCount(0);
  const [ev] = await backendEvents(page, "Review w/ Ann");
  expect((ev.raw?.attendees ?? []).map((a: any) => a.email)).toEqual(["ann@example.com"]);
});

// ---- regressions of the fixes above (found reviewing them)

const ev = (id: string, summary: string, start: string, end: string, all_day: boolean, extra: Record<string, unknown> = {}) =>
  ({ ...evt(id, "primary", summary, start, end, extra), all_day });
const storedById = (page: Page, id: string) => page.evaluate(async (id) =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-12-31T00:00:00Z")).find((r: any) => r.id === id), id);

test("panel: all-day → timed → all-day keeps a multi-day span", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [ev("r", "Retreat", "2026-10-13", "2026-10-16", true)] });
  await open(page);
  await page.locator(".chip-allday", { hasText: "Retreat" }).first().click();
  const p = panel(page);
  expect(await p.getByTestId("allday-end").inputValue()).toBe("2026-10-15");
  await p.getByRole("button", { name: "All-day" }).click();
  await p.getByRole("button", { name: "All-day" }).click();
  await p.getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => { const r = await storedById(page, "r"); return [r.start, r.end]; }).toEqual(["2026-10-13", "2026-10-16"]);
});

test("all-day: Fri → Mon across hidden weekends lands on Monday", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [ev("f", "Friday offsite", "2026-10-16", "2026-10-17", true)] });
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  const colW = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(grid.x + grid.width / 2, grid.y + 200);
  await page.mouse.wheel(Math.round(colW * 2), 0);
  await page.waitForTimeout(800); // Wed 14, Thu 15, Fri 16, Mon 19, Tue 20
  const b = (await page.locator(".chip-allday", { hasText: "Friday offsite" }).first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + colW, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => { const r = await storedById(page, "f"); return [r.start, r.end]; }).toEqual(["2026-10-19", "2026-10-20"]);
});

test("panel: a plain description with <email> is shown and saved intact", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [ev("d", "Intro call", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00", false,
    { description: "Contact: Ann Lee <ann@example.com>" })] });
  await open(page);
  await chip(page, "Intro call").click();
  const desc = panel(page).locator(".panel-desc");
  await expect(desc).toHaveValue("Contact: Ann Lee <ann@example.com>");
  await desc.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (confirmed)");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => (await storedById(page, "d")).description).toContain("ann@example.com");
});

test("panel: a guest pasted as Name <email> adds the address", async ({ page }) => {
  await fixture(page, { calendars: [PRIMARY], events: [ev("g", "Sync", "2026-10-14T10:00:00-04:00", "2026-10-14T11:00:00-04:00", false)] });
  await open(page);
  await chip(page, "Sync").click();
  const inp = panel(page).locator(".panel-attendee-input");
  await inp.fill("Ann Lee <ann@example.com>");
  await inp.press("Enter");
  await expect(inp).toHaveValue("");
  await panel(page).getByRole("button", { name: /^Save/ }).click();
  await expect.poll(async () => ((await storedById(page, "g")).raw?.attendees ?? []).map((a: any) => a.email)).toEqual(["ann@example.com"]);
});

// ---- found playing a planning day end to end (2026-10-18, run 2)

const byName = (page: Page, s: string) => backendEvents(page, s);

test("cut and paste moves an event with its reminder, busy/free and Meet link", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const b = (window as any).__mockBackend;
    const e = (await b.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).find((r: any) => r.summary === "Standup");
    await b.updateEvent(e.id, { ...e, transparency: "transparent", reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] } }, e.calendar_id);
  });
  await chip(page, "Standup").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect.poll(async () => (await byName(page, "Standup")).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(async () => (await byName(page, "Standup")).length).toBe(1);
  const [ev] = await byName(page, "Standup");
  expect([ev.raw?.transparency, ev.raw?.reminders?.overrides?.[0]?.minutes, ev.conference_url])
    .toEqual(["transparent", 30, "https://meet.google.com/mock-link"]);
});

test("undoing a delete brings back the Meet link and the review mark", async ({ page }) => {
  await open(page);
  await chip(page, "Standup").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await byName(page, "Standup")).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await byName(page, "Standup")).length).toBe(1);
  expect((await byName(page, "Standup"))[0].conference_url).toBe("https://meet.google.com/mock-link");

  const run = chip(page, "Morning run");
  await run.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /^Happened/ }).click();
  await run.click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await byName(page, "Morning run")).length).toBe(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await byName(page, "Morning run")).length).toBe(1);
  await expect(chip(page, "Morning run")).not.toHaveClass(/unsettled/);
});

test("quick create: a range ending the text is the time ('deep work 9-11')", async ({ page }) => {
  await open(page, "2026-10-19T08:30:00");
  await page.keyboard.press("c");
  await page.getByTestId("quick-create").locator("input").fill("deep work 9-11");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await byName(page, "deep work")).length).toBe(1);
  const [ev] = await byName(page, "deep work");
  expect([new Date(ev.start).getHours(), new Date(ev.end).getHours()]).toEqual([9, 11]);
});

// ---- quick create: a word that starts like a month isn't one

const startingWith = (page: Page, s: string) => page.evaluate(async (s) => (await (window as any).__mockBackend
  .listEvents("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).filter((e: any) => e.summary.startsWith(s)), s);

for (const [text, title, day, h0, h1] of [
  ["Doctor 3-4 tomorrow", "Doctor", 20, 15, 16],
  ["lunch with Jane 12-1 tomorrow", "lunch with Jane", 20, 12, 13],
  ["Call Mark 2-3 friday", "Call Mark", 23, 14, 15],
] as const) {
  test(`quick create: "${text}" is a timed event`, async ({ page }) => {
    await open(page, "2026-10-19T08:30:00");
    await page.keyboard.press("c");
    await page.getByTestId("quick-create").locator("input").fill(text);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await startingWith(page, title)).length).toBe(1);
    const [ev] = await startingWith(page, title);
    expect([ev.summary, ev.all_day, new Date(ev.start).getDate(), new Date(ev.start).getHours(), new Date(ev.end).getHours()])
      .toEqual([title, false, day, h0, h1]);
  });
}
