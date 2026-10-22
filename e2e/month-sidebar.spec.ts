// Month, list, sidebar, ⌘K, goals: found by the 2026-10-19 run 4 bug-finder
// (each failed before its fix).
import { expect, test, type Locator, type Page } from "@playwright/test";

const P = { id: "p", summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" };
const ev = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "p", etag: null, summary, description: null, location: null, start, end, all_day: !start.includes("T"),
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
/** the default mock week, or a fixture's events, at a fixed "now" */
async function open(page: Page, now = "2026-10-14T09:00:00", events?: unknown[]) {
  if (events) await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, { calendars: [P], events });
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const s = page.getByTestId("sweep-banner");
  if (await s.count()) await s.locator(".toast-close").click();
}
const cellOf = (page: Page, d: number) =>
  page.locator(".month-cell", { has: page.locator(".month-dnum", { hasText: new RegExp(`^${d}$`) }) });
/** what the eye sees: the element's opacity times every ancestor's */
const seenOpacity = (l: Locator) => l.evaluate((el) => {
  let o = 1;
  for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
  return o;
});
async function star(page: Page, l: Locator) {
  await l.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Star as goal work/ }).click();
}
async function palette(page: Page, q: string, now = "2026-10-19T09:00:00") {
  await open(page, now);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk [cmdk-input]").fill(q);
  return page.locator(".cmdk [cmdk-input]");
}
async function swipeWeeks(page: Page, n: number) {
  const g = (await page.getByTestId("week-grid").boundingBox())!;
  const w = (await page.getByTestId("day-col-0").boundingBox())!.width;
  await page.mouse.move(g.x + g.width / 2, g.y + 200);
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(Math.round(w * 7), 0);
    await page.waitForTimeout(500);
  }
}

// 1
test("month: a day's chips are in time order whatever their stored offset", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [
    ev("a", "Standup", "2026-10-20T13:00:00Z", "2026-10-20T13:15:00Z"), // 9:00 EDT
    ev("b", "Design review", "2026-10-20T10:00:00-04:00", "2026-10-20T11:00:00-04:00"),
    ev("c", "Pacific call", "2026-10-20T08:30:00-07:00", "2026-10-20T09:00:00-07:00"), // 11:30 EDT
    ev("d", "Lunch", "2026-10-20T12:00:00-04:00", "2026-10-20T13:00:00-04:00"),
    ev("e", "Gym", "2026-10-20T18:00:00-04:00", "2026-10-20T19:00:00-04:00"),
  ]);
  await page.keyboard.press("m");
  // as many as fit, in time order (the rest under "N more")
  const order = ["Standup", "Design review", "Pacific call", "Lunch", "Gym"];
  const shown = await cellOf(page, 20).locator(".mchip-title").allTextContents();
  expect(shown.length).toBeGreaterThanOrEqual(4);
  expect(shown).toEqual(order.slice(0, shown.length));
});

// 2
test("month: a multi-day bar doesn't cover the event chips on the days it crosses", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [
    ev("c", "Conference", "2026-10-12", "2026-10-15"),
    ev("t", "Talk prep", "2026-10-13T10:00:00-04:00", "2026-10-13T11:00:00-04:00"),
  ]);
  await page.keyboard.press("m");
  const bar = (await page.locator(".month-bar", { hasText: "Conference" }).boundingBox())!;
  const chip = (await page.locator(".mchip", { hasText: "Talk prep" }).boundingBox())!;
  const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".mchip")?.textContent ?? null,
    [chip.x + chip.width / 2, chip.y + 2]);
  expect(onTop).toContain("Talk prep");
  expect(chip.y).toBeGreaterThanOrEqual(bar.y + bar.height);
});

// 3
test("month: in the app's default 800×600 window a busy day's chips keep their full height", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 }); // src-tauri/tauri.conf.json
  const events = Array.from({ length: 6 }, (_, i) => {
    const h = String(9 + i).padStart(2, "0");
    return ev(`m${i}`, `Meeting ${i + 1}`, `2027-01-12T${h}:00:00-05:00`, `2027-01-12T${h}:30:00-05:00`);
  });
  await open(page, "2027-01-05T09:00:00", [...events, ev("ski", "Ski trip", "2027-01-10", "2027-01-14")]);
  await page.keyboard.press("m");
  await expect(page.locator(".month-week")).toHaveCount(6);
  const heights = await page.locator(".month-cell", { has: page.locator(".mchip-more") }).locator(".mchip")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(15); // squeezed to 9px
});

// 4
test("sidebar: the mini-month follows a swipe into the next month", async ({ page }) => {
  await open(page);
  await swipeWeeks(page, 3);
  await expect(page.locator(".topbar-title")).toHaveText("November 2026");
  await expect(page.getByTestId("mini-month").locator(".mini-title")).toHaveText("November 2026");
  await expect(page.locator(".mini-day.selected")).not.toHaveText("14");
});

// 5
test("⌘K: “last friday” / “last monday” go back, and “oct 12” is this October", async ({ page }) => {
  const goTo = page.locator("[cmdk-item]", { hasText: "Go to" });
  const input = await palette(page, "last friday"); // now: Monday Oct 19
  await expect(goTo).toContainText("October 16, 2026"); // Fri, October 23
  await input.fill("last monday");
  await expect(goTo).toContainText("October 12, 2026"); // Mon, October 26
  await input.fill("oct 12");
  await expect(goTo).toContainText("October 12, 2026"); // Tue, October 12, 2027
});

// 6
test("stars: a starred event shows as goal work in month and list too", async ({ page }) => {
  await open(page);
  const c = page.locator(".chip-timed", { hasText: "Morning run" }).first();
  await star(page, c);
  await expect(c).toHaveClass(/(^| )starred( |$)/);
  await page.keyboard.press("m");
  await expect(page.locator(".mchip", { hasText: "Morning run" }).first()).toHaveClass(/(^| )starred( |$)/);
  await page.keyboard.press("l");
  await expect(page.locator(".agenda-row", { hasText: "Morning run" }).first()).toHaveClass(/(^| )starred( |$)/);
});

// 7
test("spotlight: a starred all-day event and a starred cluster row stay lit", async ({ page }) => {
  await open(page);
  const offsite = page.locator(".chip-allday", { hasText: "Offsite" }).first();
  await star(page, offsite);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 17 * 48));
  const row = page.getByTestId("cluster-block").filter({ hasText: "shopping app" })
    .locator(".cluster-row", { hasText: "group chat spiral" });
  await star(page, row);
  await page.keyboard.press("g");
  await expect.poll(() => seenOpacity(offsite)).toBe(1); // 0.18
  await expect.poll(() => seenOpacity(row)).toBe(1); // 0.18
});

// 8
test("month: a multi-day invitation and a canceled multi-day event look it in the month bars", async ({ page }) => {
  const invite = { raw: { organizer: { email: "chair@example.com" }, attendees: [
    { email: "chair@example.com", organizer: true, responseStatus: "accepted" },
    { email: "me@example.com", self: true, responseStatus: "needsAction" }] } };
  await open(page, "2026-10-14T09:00:00", [
    ev("conf", "Conference", "2026-10-12", "2026-10-15", invite), ev("ret", "Retreat", "2026-10-15", "2026-10-17")]);
  await expect(page.locator(".chip-allday", { hasText: "Conference" }).first()).toHaveClass(/invite-pending/);
  await page.locator(".chip-allday", { hasText: "Retreat" }).first().click({ button: "right" });
  await page.getByTestId("ctx-cancel").click();
  await page.keyboard.press("m");
  await expect(page.locator(".month-bar", { hasText: "Conference" })).toHaveClass(/invite-pending/);
  await expect(page.locator(".month-bar", { hasText: "Retreat" })).toHaveClass(/canceled/);
});

// 9
test("month: a chip's time is readable on its calendar's tint in light mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, "2026-10-14T09:00:00", [ev("t", "Talk prep", "2026-10-13T10:00:00-04:00", "2026-10-13T11:00:00-04:00")]);
  await page.keyboard.press("m");
  const ratio = await page.locator(".mchip", { hasText: "Talk prep" }).evaluate((chip) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgb = (c: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (c: number[]) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const a = lum(rgb(getComputedStyle(chip.querySelector(".mchip-time")!).color)), b = lum(rgb(getComputedStyle(chip).backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(3); // 1.19
});

// 10
test("multi-day timed event: no first-day start time on later month days; the list says the end day", async ({ page }) => {
  await open(page, "2026-10-14T09:00:00", [ev("trip", "Road trip", "2026-10-16T18:00:00-04:00", "2026-10-18T14:00:00-04:00")]);
  await page.keyboard.press("m");
  await expect(cellOf(page, 18).locator(".mchip", { hasText: "Road trip" })).toHaveCount(1);
  await expect(cellOf(page, 18).locator(".mchip", { hasText: "Road trip" }).locator(".mchip-time")).toHaveCount(0);
  await page.keyboard.press("l");
  await expect(page.locator(".agenda-row", { hasText: "Road trip" }).locator(".agenda-time")).toContainText(/Sun|Oct 18|18/);
});

// 11
test("goals: after deleting a goal, the event panel and the grid agree on its events", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" }).first();
  await chip.click();
  await page.getByTestId("goal-link").selectOption("3 gym sessions");
  await page.keyboard.press("Escape");
  const row = page.getByTestId("goal-row").filter({ hasText: "3 gym sessions" });
  await row.hover();
  await row.getByRole("button", { name: "Delete goal" }).click();
  await chip.click();
  const starredOnGrid = /(^| )starred( |$)/.test((await chip.getAttribute("class")) ?? "");
  const notGoalWork = (await page.getByTestId("goal-link").inputValue()) === "";
  expect(notGoalWork).toBe(!starredOnGrid); // gold ring on the grid, "Not goal work" in the panel
});

// 12
test("goals: hovering a goal's ★ count names the starred events", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).first().click();
  await page.getByTestId("goal-link").selectOption("3 gym sessions");
  await page.keyboard.press("Escape");
  const badge = page.getByTestId("goal-row").filter({ hasText: "3 gym sessions" }).locator(".goal-star-count");
  await expect(badge).toContainText("★ 1");
  await expect(badge).toHaveAttribute("title", /Morning run/); // "1 event(s)"
});

// 13
test("thought dump: editing a long thought shows all of it", async ({ page }) => {
  await open(page);
  const add = page.getByTestId("thought-add");
  await add.fill("Whether to take the summer research offer or the internship, and what each one means for the thesis timeline");
  await add.press("Enter");
  await page.getByTestId("thought-row").first().locator(".thought-text").dblclick();
  const [client, scroll] = await page.locator(".thought-edit").evaluate((el) => [el.clientHeight, el.scrollHeight]);
  expect(scroll).toBeLessThanOrEqual(client + 2); // 87 vs 19: one line of five
});

// 14
test("view menu: day counts open under “Number of days”; View settings folds on close; Escape closes", async ({ page }) => {
  await open(page);
  const rows = page.getByTestId("view-menu").getByRole("menuitem");
  await page.getByTestId("view-menu-btn").click();
  await page.getByTestId("view-menu-days").click();
  const labels = (await rows.allTextContents()).map((t) => t.replace(/[✓›]/g, "").trim());
  expect(labels[labels.findIndex((t) => t.startsWith("Number of days")) + 1]).toMatch(/^2 days/); // "View settings"
  await page.getByTestId("view-menu-settings").click();
  await page.mouse.click(600, 400);
  await page.getByTestId("view-menu-btn").click();
  await expect(rows.filter({ hasText: "Scarf joint" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-menu")).toHaveCount(0);
});

// 15
test("panes: with an event open, the panel's resize strip stays off the top bar (⌘K button)", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const k = (await page.getByRole("button", { name: "Command menu" }).boundingBox())!;
  await page.mouse.click(k.x + 3, k.y + k.height / 2);
  await expect(page.locator(".cmdk")).toBeVisible();
});

// 16
test("month: with weekends turned off, the month shows weekdays only", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.locator("[data-testid^=day-col-]")).toHaveCount(5);
  await page.keyboard.press("m");
  await expect(page.locator(".month-dow-row span")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri"]);
});

// 17
test("“N more” and ⌘K “Day view” show one day after a 3-day view was used", async ({ page }) => {
  await open(page);
  await page.keyboard.press("3");
  await page.keyboard.press("m");
  await page.locator(".mchip-more").first().click();
  await expect(page.locator(".day-head")).toHaveCount(1); // 3
  await page.keyboard.press("w");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk [cmdk-input]").fill("day");
  await page.locator("[cmdk-item]", { hasText: "Day view" }).click();
  await expect(page.locator(".day-head")).toHaveCount(1); // 3
});

// 18
test("⌘K: “month view” finds Month view; “sync now” ↵ syncs, not Go to today", async ({ page }) => {
  const input = await palette(page, "month view");
  await expect(page.locator("[cmdk-item]", { hasText: "Month view" })).toBeVisible(); // "No results."
  await input.fill("sync now");
  await expect(page.locator("[cmdk-item][aria-selected=true]")).toContainText("Sync now"); // "📅 Go to …"
});

// 19
test("panes: a chosen panel width comes back when the window widens after launch", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pane-w-panel", "600"));
  await page.setViewportSize({ width: 800, height: 600 }); // the window opens at 800×600
  await open(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  expect(Math.round(await page.getByTestId("event-panel").evaluate((el) => el.getBoundingClientRect().width))).toBe(600); // 480
});
