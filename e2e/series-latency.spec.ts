import { expect, test, type Page } from "@playwright/test";

const NOW = "2026-10-14T09:00:00";

test("recurring series updates appear before a slow remote write finishes", async ({ page }) => {
  const instants = [12, 13, 14].map((day, i) => ({
    id: `daily-${i}`,
    calendar_id: "primary",
    etag: null,
    summary: "Daily review",
    description: null,
    location: null,
    start: `2026-10-${day}T09:00:00-04:00`,
    end: `2026-10-${day}T10:00:00-04:00`,
    all_day: false,
    timezone: "America/New_York",
    status: "confirmed",
    recurrence: null,
    recurring_event_id: "daily-master",
    conference_url: null,
    updated: null,
    raw: { originalStartTime: { dateTime: `2026-10-${day}T09:00:00-04:00` } },
  }));
  await page.addInitScript((events) => {
    (globalThis as any).__calFixture = {
      calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
      events,
    };
  }, instants);
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");

  // The native command can take seconds to receive Google's response. Keep
  // its mock promise pending after the local rows are updated to reproduce
  // that network delay without making the calendar itself wait.
  await page.evaluate(() => {
    const backend = (window as any).__mockBackend;
    const update = backend.updateSeriesMaster.bind(backend);
    backend.updateSeriesMaster = async (...args: unknown[]) => {
      await update(...args);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    };
  });

  await page.getByTestId("day-col-1").locator(".chip-timed", { hasText: "Daily review" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Daily review — revised");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();

  await expect(page.getByTestId("toast")).toContainText("Saving series changes", { timeout: 1500 });
  await expect(panel).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator(".chip-timed", { hasText: "Daily review — revised" })).toHaveCount(3, { timeout: 1500 });
  await expect(page.getByTestId("toast")).toContainText("Updated all", { timeout: 6000 });
});

test("this-and-following split appears before a slow truncate finishes", async ({ page }) => {
  const events = [12, 13, 14].map((day, i) => ({
    id: `split-${i}`,
    calendar_id: "primary",
    etag: null,
    summary: "Daily plan",
    description: null,
    location: null,
    start: `2026-10-${day}T09:00:00-04:00`,
    end: `2026-10-${day}T10:00:00-04:00`,
    all_day: false,
    timezone: "America/New_York",
    status: "confirmed",
    recurrence: null,
    recurring_event_id: "split-master",
    conference_url: null,
    updated: null,
    raw: { originalStartTime: { dateTime: `2026-10-${day}T09:00:00-04:00` } },
  }));
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.evaluate(() => {
    const backend = (window as any).__mockBackend;
    const split = backend.splitSeries.bind(backend);
    backend.splitSeries = async (...args: unknown[]) => {
      const id = await split(...args);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return id;
    };
  });

  await page.getByTestId("day-col-2").locator(".chip-timed", { hasText: "Daily plan" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Daily plan — changed");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();

  await expect(page.getByTestId("toast")).toContainText("Saving series changes", { timeout: 1500 });
  await expect(panel).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator(".chip-timed", { hasText: "Daily plan — changed" })).toBeVisible({ timeout: 1500 });
  await expect(page.getByTestId("toast")).toContainText("and following", { timeout: 6000 });
});

test("COUNT series split stays responsive while counting remote instances", async ({ page }) => {
  const events = [12, 13, 14].map((day, i) => ({
    id: `count-${i}`,
    calendar_id: "primary",
    etag: null,
    summary: "Counted review",
    description: null,
    location: null,
    start: `2026-10-${day}T09:00:00-04:00`,
    end: `2026-10-${day}T10:00:00-04:00`,
    all_day: false,
    timezone: "America/New_York",
    status: "confirmed",
    recurrence: null,
    recurring_event_id: "count-master",
    conference_url: null,
    updated: null,
    raw: {
      originalStartTime: { dateTime: `2026-10-${day}T09:00:00-04:00` },
      masterRecurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
    },
  }));
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events,
  });
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await page.evaluate(() => {
    const backend = (window as any).__mockBackend;
    backend.getSeriesInstances = async () => {
      throw new Error("COUNT split should not block on a preflight instance fetch");
    };
    const create = backend.createEvent.bind(backend);
    backend.createEvent = async (input: any) => {
      (window as any).__countSplitRecurrence = input.recurrence;
      return create(input);
    };
    const split = backend.splitSeries.bind(backend);
    backend.splitSeries = async (...args: unknown[]) => {
      (window as any).__countSplitSelected = (args[4] as any)?.selectedOriginalStart;
      const id = await split(...args);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return id;
    };
  });

  await page.getByTestId("day-col-2").locator(".chip-timed", { hasText: "Counted review" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Counted review — changed");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();

  await expect(page.getByTestId("toast")).toContainText("Saving series changes", { timeout: 1500 });
  await expect(panel).toHaveCount(0, { timeout: 1500 });
  await expect(page.locator(".chip-timed", { hasText: "Counted review — changed" })).toBeVisible({ timeout: 1500 });
  const selectedOriginal = await page.evaluate(() => (window as any).__countSplitSelected);
  const boundary = Date.parse(selectedOriginal.dateTime ?? `${selectedOriginal.date}T00:00:00Z`);
  const earlier = events.filter((event) => Date.parse(event.raw.originalStartTime.dateTime) < boundary).length;
  await expect.poll(() => page.evaluate(() => (window as any).__countSplitRecurrence)).toEqual([
    `RRULE:FREQ=DAILY;COUNT=${5 - earlier}`,
  ]);
  await expect(page.getByTestId("toast")).toContainText("and following", { timeout: 6000 });
});
