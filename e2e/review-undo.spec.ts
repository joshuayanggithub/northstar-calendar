// Review marks and undo: found by the 2026-10-20 run 5 bug-finder (each failed
// before its fix).
import { expect, test, type Page } from "@playwright/test";

const CALS = [
  { id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" },
];
const ev = (id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id, calendar_id: "primary", etag: null, summary, description: null, location: null, start, end, all_day: false,
  timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null, conference_url: null, updated: null, raw: {}, ...extra,
});
const NOW = "2026-10-14T09:00:00";
async function open(page: Page, now = NOW) {
  await page.goto(`/?now=${encodeURIComponent(now)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}
const recon = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("recon") ?? "{}"));
const title = (page: Page, id: string) => page.evaluate(async (id) =>
  (await (window as any).__mockBackend.listEvents("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")).find((r: any) => r.id === id)?.summary, id);

test("queue: a declined invitation (hidden from the grid) is not asked about", async ({ page }) => {
  const declined = ev("standup", "Standup", "2026-10-13T10:00:00-04:00", "2026-10-13T10:30:00-04:00", {
    raw: {
      organizer: { email: "boss@example.com", self: false },
      attendees: [
        { email: "boss@example.com", organizer: true, responseStatus: "accepted" },
        { email: "me@example.com", self: true, responseStatus: "declined" },
      ],
    },
  });
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    localStorage.setItem("prefs", JSON.stringify({ showDeclined: false }));
  }, { calendars: CALS, events: [declined] });
  await open(page);
  // the grid hides it and the morning sweep has nothing for yesterday…
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(0);
  await expect(page.getByTestId("sweep-banner")).toHaveCount(0);
  // …but R asks whether the meeting you declined happened
  await page.keyboard.press("r");
  const card = page.getByTestId("recon-pill");
  await expect(page.getByTestId("toast").or(card)).toBeVisible();
  expect(await card.count(), "a review card for the declined meeting").toBe(0);
  await expect(page.getByTestId("toast")).toContainText("Nothing to review");
});

test("undo: ⌘Z after the context menu's Canceled on an ended event restores it (as Cancel event does)", async ({ page }) => {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; },
    { calendars: CALS, events: [ev("gym", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00")] });
  await open(page);
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
  const chip = page.locator(".chip-timed", { hasText: "Gym" }).first();
  // an earlier, unrelated undoable edit
  await chip.click({ position: { x: 6, y: 6 } });
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Gym!");
  await panel.getByRole("button", { name: /Save/ }).click();
  await expect.poll(() => title(page, "gym")).toBe("Gym!");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await chip.click({ button: "right", position: { x: 6, y: 6 } });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /^Canceled/ }).click();
  await expect(chip).toHaveClass(/canceled/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toContainText("Undid");
  const undid = await page.getByTestId("toast").textContent();
  expect.soft(await chip.getAttribute("class"), `toast said "${undid}"`).not.toMatch(/canceled/);
  await expect.poll(() => title(page, "gym"), `toast said "${undid}": the older edit must stay`).toBe("Gym!");
});

test("undo: ⌘Z after the review card's It happened takes the mark back, not the edit under it", async ({ page }) => {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; },
    { calendars: CALS, events: [ev("gym", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00")] });
  await open(page);
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
  const chip = page.locator(".chip-timed", { hasText: "Gym" }).first();
  await chip.click({ position: { x: 6, y: 6 } });
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Gym!");
  await panel.getByRole("button", { name: /Save/ }).click();
  await expect.poll(() => title(page, "gym")).toBe("Gym!");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("r");
  await page.getByTestId("recon-pill").getByTestId("recon-btn-yes").click();
  await expect.poll(async () => (await recon(page)).gym?.s).toBe("done");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toContainText("Undid");
  const undid = await page.getByTestId("toast").textContent();
  expect.soft((await recon(page)).gym?.s, `toast said "${undid}"`).toBeUndefined();
  await expect.poll(() => title(page, "gym"), `toast said "${undid}": the older edit must stay`).toBe("Gym!");
});

test("undo: ⌘Z after the panel's Happened takes the mark back", async ({ page }) => {
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; },
    { calendars: CALS, events: [ev("gym", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00")] });
  await open(page);
  const s = page.getByTestId("sweep-banner"); if (await s.count()) await s.locator(".toast-close").click();
  await page.locator(".chip-timed", { hasText: "Gym" }).first().click({ position: { x: 6, y: 6 } });
  await page.getByTestId("panel-recon-yes").click();
  await expect(page.getByTestId("panel-recon-yes")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("panel-recon-yes")).toHaveAttribute("aria-checked", "false");
});

test("storage: a corrupt recon value doesn't blank the app", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    localStorage.setItem("recon", "null");
  }, { calendars: CALS, events: [ev("gym", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00")] });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await page.waitForTimeout(1500);
  expect(errors, "page errors").toEqual([]);
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toBeVisible();
});

test("storage: a corrupt recon entry doesn't blank the app", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
    localStorage.setItem("recon", JSON.stringify({ gym: null }));
  }, { calendars: CALS, events: [ev("gym", "Gym", "2026-10-13T17:00:00-04:00", "2026-10-13T18:00:00-04:00")] });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await page.waitForTimeout(1500);
  expect(errors, "page errors").toEqual([]);
  await expect(page.locator(".chip-timed", { hasText: "Gym" })).toBeVisible();
});
