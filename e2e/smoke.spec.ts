import { expect, test, type Page } from "@playwright/test";

// Fixed clock so mock data and the grid are deterministic.
const NOW = "2026-10-14T09:00:00";

async function panelDateValue(panel: import("@playwright/test").Locator): Promise<string> {
  await panel.locator(".panel-date-pretty").click();
  const v = await panel.locator('input[type="date"]:not(.allday-end)').inputValue();
  await panel.locator('input[type="date"]:not(.allday-end)').blur();
  return v;
}


async function open(page: Page, extra = "") {
  await page.goto(`/?now=${encodeURIComponent(NOW)}${extra}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  // the morning sweep banner floats over the UI; most tests aren't about it
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) {
    await sweep.locator(".toast-close").click();
    await expect(sweep).toHaveCount(0);
  }
}

test("week view renders events on the grid", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toBeVisible();
  await expect(page.locator(".day-head.today .dnum")).toHaveText("14");
  await expect(page.locator(".now-line")).toBeVisible();
});

test("view switching: day, month, list, and shortcuts", async ({ page }) => {
  await open(page);
  await page.getByTestId("view-menu-btn").click();
  await page.getByTestId("view-menu").getByRole("menuitem", { name: /^Month/ }).click();
  await expect(page.getByTestId("month-grid")).toBeVisible();
  await page.keyboard.press("d");
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.locator(".day-head")).toHaveCount(1);
  await page.keyboard.press("l");
  await expect(page.getByTestId("agenda-list")).toBeVisible();
  await expect(page.locator(".agenda-row", { hasText: "Standup" })).toBeVisible();
  await page.keyboard.press("w");
  await expect(page.locator(".day-head")).toHaveCount(7);
});

test("clicking a chip opens the event panel; edit title saves", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).click();
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".panel-title")).toHaveValue("Standup");
  await panel.locator(".panel-title").fill("Standup (renamed)");
  await panel.getByRole("button", { name: /Save/ }).click();
  await expect(page.locator(".chip-timed", { hasText: "Standup (renamed)" })).toBeVisible();
});

test("drag on empty grid creates a draft and saving adds the event", async ({ page }) => {
  await open(page);
  const col = page.getByTestId("day-col-4"); // Thursday
  const box = (await col.boundingBox())!;
  // drag from 13:00 to 14:00 (48px/hour from top of grid body)
  const startY = box.y + 13 * 48 + 2;
  await page.mouse.move(box.x + box.width / 2, startY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, startY + 48, { steps: 6 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  await panel.locator(".panel-title").fill("Deep work session");
  await panel.getByRole("button", { name: /Create/ }).click();
  await expect(page.locator(".chip-timed", { hasText: "Deep work session" })).toBeVisible();
});

test("quick create parses natural language", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create");
  await expect(qc).toBeVisible();
  await qc.locator("input").fill("coffee with alex friday 3pm");
  await expect(qc.locator(".qc-preview")).toContainText("coffee with alex");
  await expect(qc.locator(".qc-preview")).toContainText("3:00");
  await qc.locator("input").press("Enter");
  await expect(page.locator(".chip-timed", { hasText: "coffee with alex" })).toBeVisible();
});

test("command menu: search event and jump to date", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+k");
  const cmdk = page.locator(".cmdk");
  await expect(cmdk).toBeVisible();
  await cmdk.locator("[cmdk-input]").fill("dentist");
  await expect(cmdk.getByText("Dentist")).toBeVisible();
  await cmdk.locator("[cmdk-input]").fill("");
  await cmdk.locator("[cmdk-input]").fill("nov 20");
  await cmdk.getByText(/Go to .*November 20/).click();
  await expect(page.locator(".topbar-title")).toHaveText("November 2026");
});

test("calendar visibility toggle hides chips", async ({ page }) => {
  await open(page);
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toBeVisible();
  await page.locator(".cal-row", { hasText: "Work" }).click();
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(0);
});

test("delete from panel removes the event", async ({ page }) => {
  await open(page);
  await page.keyboard.press("l"); // list view spans 14 days, catching Dentist
  await page.locator(".agenda-row", { hasText: "Dentist" }).click();
  await page.getByTestId("event-panel").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".agenda-row", { hasText: "Dentist" })).toHaveCount(0);
});

test("mini month navigates", async ({ page }) => {
  await open(page);
  await page.getByTestId("mini-month").getByRole("button", { name: "Next month" }).click();
  await page.getByTestId("mini-month").getByRole("button", { name: "17", exact: true }).click();
  await expect(page.locator(".topbar-title")).toHaveText("November 2026");
});

test("visual: week view matches snapshot", async ({ page }) => {
  await open(page);
  await expect(page).toHaveScreenshot("week-view.png", { maxDiffPixelRatio: 0.002, threshold: 0.05 });
});

test("visual: month view matches snapshot", async ({ page }) => {
  await open(page);
  await page.keyboard.press("m");
  await expect(page.getByTestId("month-grid")).toBeVisible();
  await expect(page).toHaveScreenshot("month-view.png", { maxDiffPixelRatio: 0.002, threshold: 0.05 });
});

// --- regression tests for user-reported bugs (2026-10-14) ---

test("bug: dragging an event must not select text and must move the event", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  // drag down 2 hours (96px), wiggling across text on the way
  await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 96, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".chip-timed", { hasText: "Morning run" }).locator(".chip-time"))
    .toHaveText("9 – 10 AM");
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toBe("");
});

test("parity: event editor docks full-height on the right (Notion)", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x + box.width).toBeGreaterThanOrEqual(vp.width - 2); // flush right
  expect(box.height).toBeGreaterThanOrEqual(vp.height - 2); // full height
  await expect(panel.locator(".panel-dur")).toContainText("1h"); // duration label
});

test("drag-create opens the docked editor with the dragged range", async ({ page }) => {
  await open(page);
  const col = page.getByTestId("day-col-1"); // Monday
  const box = (await col.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 13 * 48;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 48, { steps: 5 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator('input[type="time"]').first()).toHaveValue("13:00");
  expect(await panelDateValue(panel)).toBe("2026-10-12");
  await page.keyboard.press("Escape");
});

test("bug: hidden calendars can be shown again (hover affordance)", async ({ page }) => {
  await open(page);
  const work = page.locator(".cal-row", { hasText: "Work" });
  await work.click(); // hide
  await expect(work).toHaveClass(/hidden-cal/);
  await expect(work.locator(".cal-eye")).toHaveText("Show");
  await work.click(); // show again
  await expect(work).not.toHaveClass(/hidden-cal/);
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toBeVisible();
});

test("bug: calendars can be created and subscribed from the sidebar", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Add calendar" }).click();
  const form = page.getByTestId("cal-add-form");
  await form.locator("input").fill("Side projects");
  await expect(form.locator(".cal-add-hint")).toContainText("create new calendar");
  await form.locator("input").press("Enter");
  await expect(page.locator(".cal-row", { hasText: "Side projects" })).toBeVisible();

  await page.getByRole("button", { name: "Add calendar" }).click();
  await form.locator("input").fill("en.usa#holiday@group.v.calendar.google.com");
  await expect(form.locator(".cal-add-hint")).toContainText("subscribe");
  await form.locator("input").press("Enter");
  await expect(page.locator(".cal-row", { hasText: "en.usa#holiday" })).toBeVisible();
});

// --- UX parity with Notion/Google ground truth (design/references/notion-shortcuts.md) ---

test("parity: escape cancels an in-progress drag", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const before = await chip.locator(".chip-time").textContent();
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 96, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(chip.locator(".chip-time")).toHaveText(before!);
});

test("parity: select, backspace deletes, cmd+z undoes with toast", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  await page.keyboard.press("Escape"); // close panel, selection kept
  await page.keyboard.press("Backspace");
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(0);
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Deleted “Morning run”");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toBeVisible();
});

test("parity: cmd+d duplicates the selected event", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+d");
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z"); // undo the duplicate
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(1);
});

test("parity: ended events fade once confirmed; now pill and global line shown", async ({ page }) => {
  await open(page); // now = 9:00, Morning run ends 8:00 -> ended but unconfirmed
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveClass(/unsettled/);
  // Sunday is outside the 48h recon window -> grandfathered into the past wash
  await expect(page.locator(".chip-timed", { hasText: "quiz review" })).toHaveClass(/past/);
  await expect(page.locator(".chip-timed", { hasText: "Swim" })).not.toHaveClass(/past/);
  await expect(page.getByTestId("now-pill")).toHaveText(/9:00/);
  await expect(page.locator(".now-line-global")).toBeVisible();
});

test("parity: j/k navigate periods, 0/1 switch views, backtick toggles sidebar", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j");
  await expect(page.locator(".day-head", { hasText: "18" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.locator(".day-head.today")).toBeVisible();
  await page.keyboard.press("1");
  await expect(page.locator(".day-head")).toHaveCount(1);
  await page.keyboard.press("0");
  await expect(page.locator(".day-head")).toHaveCount(7);
  await page.keyboard.press("`");
  await expect(page.locator(".sidebar")).toBeHidden();
  await page.keyboard.press("`");
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("parity: right-click context menu deletes", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).click({ button: "right" });
  const menu = page.getByTestId("ctx-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: /Delete/ }).click();
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toBeVisible();
});

test("parity: draft chip stays visible while creating", async ({ page }) => {
  await open(page);
  const col = page.getByTestId("day-col-1");
  const box = (await col.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 13 * 48;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 48, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await expect(page.getByTestId("draft-chip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("draft-chip")).toHaveCount(0);
});

test("parity: changing start time preserves duration", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click(); // 18:00-20:00
  const panel = page.getByTestId("event-panel");
  await panel.locator('input[type="time"]').first().fill("19:00");
  await expect(panel.locator('input[type="time"]').nth(1)).toHaveValue("21:00");
});

test("parity: month shows multi-day events as a spanning bar", async ({ page }) => {
  await open(page);
  await page.keyboard.press("m");
  const bar = page.getByTestId("month-bar").filter({ hasText: "Offsite" });
  await expect(bar).toHaveCount(1);
  const barBox = (await bar.boundingBox())!;
  const cell = (await page.locator(".month-cell").first().boundingBox())!;
  expect(barBox.width).toBeGreaterThan(cell.width * 1.5); // spans ~2 columns
});

test("parity: n/b cycle selection with a visible ring", async ({ page }) => {
  await open(page);
  await page.keyboard.press("n");
  await expect(page.locator(".chip-timed.selected")).toHaveCount(1);
  const first = await page.locator(".chip-timed.selected .chip-title").textContent();
  await page.keyboard.press("n");
  const second = await page.locator(".chip-timed.selected .chip-title").textContent();
  expect(second).not.toBe(first);
  await page.keyboard.press("b");
  await expect(page.locator(".chip-timed.selected .chip-title")).toHaveText(first!);
});

// --- correctness sprint batch 1 ---

test("correctness: upward drag-create produces the right range", async ({ page }) => {
  await open(page);
  const col = page.getByTestId("day-col-2"); // Tuesday
  const box = (await col.boundingBox())!;
  const x = box.x + box.width / 2;
  // drag UP from 16:00 to 15:00
  await page.mouse.move(x, box.y + 16 * 48);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 15 * 48, { steps: 5 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  await expect(panel.locator('input[type="time"]').first()).toHaveValue("15:00");
  await expect(panel.locator('input[type="time"]').nth(1)).toHaveValue("16:00");
  await page.keyboard.press("Escape");
});

test("correctness: end before start clamps on save", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click(); // 18-20
  const panel = page.getByTestId("event-panel");
  await panel.locator('input[type="time"]').nth(1).fill("17:00"); // before start
  await panel.getByRole("button", { name: /Save/ }).click();
  // 30-min chips are too short to show inline time; verify by reopening.
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  await expect(page.getByTestId("event-panel").locator('input[type="time"]').nth(1)).toHaveValue(
    "18:30",
  );
  await page.keyboard.press("Escape");
});

test("correctness: switching calendars in the panel recolors the event", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click(); // Personal
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-cal-trigger").click();
  const choices = panel.getByTestId("panel-cal-options");
  await expect(choices.getByRole("option", { name: "Work" })).toBeVisible();
  const swatches = choices.locator(".panel-cal-option-dot");
  expect(await swatches.count()).toBeGreaterThan(1);
  for (const dot of await swatches.all()) {
    expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  }
  await choices.getByRole("option", { name: "Work" }).click();
  await expect(panel.getByTestId("panel-cal-trigger")).toContainText("Work");
  await panel.getByRole("button", { name: /Save/ }).click();
  const chip = page.locator(".chip-timed", { hasText: "Swim" });
  const calNow = await chip.evaluate((el) => getComputedStyle(el).getPropertyValue("--cal").trim());
  const vg = parseInt(calNow.slice(1), 16);
  expect((vg >> 8) & 255).toBeGreaterThan(vg & 255); // green-dominant (Work)
  await page.keyboard.press("ControlOrMeta+z"); // undo restores calendar
  const calBack = await chip.evaluate((el) => getComputedStyle(el).getPropertyValue("--cal").trim());
  const vb = parseInt(calBack.slice(1), 16);
  expect(vb & 255).toBeGreaterThan((vb >> 8) & 255); // blue-dominant (Personal)
});

test("calendar picker Escape closes without saving the event", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-cal-trigger").click();
  await expect(panel.getByTestId("panel-cal-options")).toBeVisible();
  await panel.getByTestId("panel-cal-options").getByRole("option", { name: "Work" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel.getByTestId("panel-cal-options")).toHaveCount(0);
  await expect(panel.locator(".panel-title")).toHaveValue("Swim");
});

test("calendar picker can move an event into an editable hidden calendar", async ({ page }) => {
  await open(page);
  await page.locator(".cal-row", { hasText: "Work" }).click();
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-cal-trigger").click();
  await expect(panel.getByTestId("panel-cal-options").getByRole("option", { name: "Work" })).toBeVisible();
});

test("calendar picker keyboard navigation changes the draft without saving", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  const trigger = panel.getByTestId("panel-cal-trigger");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const choices = panel.getByTestId("panel-cal-options");
  await expect(choices).toBeVisible();
  await expect(choices.locator('[aria-selected="true"]')).toBeFocused();
  await page.keyboard.press("End");
  const last = choices.getByRole("option").last();
  await expect(last).toBeFocused();
  const name = (await last.textContent())!.trim();
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText(name);
  await expect(panel).toBeVisible();
});

test("visual: calendar picker shows calendar colors in both themes", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-cal-trigger").click();
  await expect(panel.getByTestId("panel-cal-options")).toBeVisible();
  await expect(panel).toHaveScreenshot("panel-calendar-picker.png", {
    threshold: 0.05,
    maxDiffPixelRatio: 0.005,
  });
});

test("correctness: timed -> all-day toggle moves event to all-day row", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByRole("button", { name: "All-day" }).click();
  await panel.getByRole("button", { name: /Save/ }).click();
  await expect(page.locator(".chip-allday", { hasText: "Swim" })).toBeVisible();
  await expect(page.locator(".chip-timed", { hasText: "Swim" })).toHaveCount(0);
});

test("correctness: overlap cascade clicks hit the top chip", async ({ page }) => {
  await open(page);
  // Friday stress cluster: "morning walk" paints over the Sleep slab
  await page.getByTestId("day-col-5").locator(".chip-timed", { hasText: "morning walk" }).click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.locator(".panel-title")).toHaveValue("morning walk");
  await page.keyboard.press("Escape");
});

test("correctness: move across midnight renders on both days", async ({ page }) => {
  await open(page);
  // Move Swim (Fri 18-20) to Fri 23:00 -> spans into Saturday
  const chip = page.locator(".chip-timed", { hasText: "Swim" });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 5 * 48, { steps: 6 });
  await page.mouse.up();
  // two rendered segments now (Fri 23-24, Sat 0-1)
  await expect(page.locator(".chip-timed", { hasText: "Swim" })).toHaveCount(2);
});

test("correctness: quick create with explicit range", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create");
  await qc.locator("input").fill("study session friday 3-5pm");
  await expect(qc.locator(".qc-preview")).toContainText("3:00");
  await expect(qc.locator(".qc-preview")).toContainText("5:00");
  await qc.locator("input").press("Enter");
  const chip = page.locator(".chip-timed", { hasText: "study session" });
  await expect(chip.locator(".chip-time")).toHaveText("3 – 5 PM");
});

test("correctness: month double-click creates an all-day draft", async ({ page }) => {
  await open(page);
  await page.keyboard.press("m");
  const cell = page.locator(".month-cell").nth(24); // some empty-ish cell
  await cell.dblclick({ position: { x: 10, y: 60 } });
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".all-day-label")).toHaveText("All day");
  await page.keyboard.press("Escape");
});

test("correctness: move-undo restores previous time", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const before = await chip.locator(".chip-time").textContent();
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 96, { steps: 5 });
  await page.mouse.up();
  await expect(chip.locator(".chip-time")).not.toHaveText(before!);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(chip.locator(".chip-time")).toHaveText(before!);
});

test("correctness: cmd+z with empty stack shows no toast", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("correctness: shortcuts are suppressed during a drag", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 3 });
  await page.keyboard.press("m"); // must NOT switch to month mid-drag
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();
});

test("correctness: command-menu date jump goes forward", async ({ page }) => {
  await open(page); // now = Oct 14 2026
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk [cmdk-input]").fill("jan 3");
  await page.locator(".cmdk").getByText(/Go to .*January 3, 2027/).click();
  await expect(page.locator(".topbar-title")).toHaveText("January 2027");
});

test("correctness: month 'N more' opens the day view", async ({ page }) => {
  await open(page);
  await page.keyboard.press("m");
  const more = page.locator(".mchip-more").first();
  await more.click();
  await expect(page.locator(".day-head")).toHaveCount(1);
});

test("correctness: drag-create stays in its anchor day column", async ({ page }) => {
  await open(page);
  const col = page.getByTestId("day-col-2"); // Tuesday
  const box = (await col.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 15 * 48);
  await page.mouse.down();
  // wander into Thursday while dragging
  await page.mouse.move(box.x + box.width * 2, box.y + 16 * 48, { steps: 6 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  expect(await panelDateValue(panel)).toBe("2026-10-13"); // Tuesday
  await page.keyboard.press("Escape");
});

// --- correctness sprint batch 2: editor dismissal semantics (Google parity) ---

test("parity: clicking another chip switches the panel directly", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.locator(".panel-title")).toHaveValue("Morning run");
  // Standup is also on Wednesday, well clear of the docked panel
  await page.locator(".chip-timed", { hasText: "Standup" }).click();
  await expect(panel.locator(".panel-title")).toHaveValue("Standup");
});

test("parity: click-away dismisses the editor without creating an event", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  const col = page.getByTestId("day-col-0"); // Sunday, empty area (5 PM)
  const box = (await col.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 17 * 48);
  await expect(page.getByTestId("event-panel")).toHaveCount(0);
  // and no draft chip / new event appeared from that dismissing click
  await expect(page.getByTestId("draft-chip")).toHaveCount(0);
});

test("correctness: description and location round-trip through the panel", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByPlaceholder("Location").fill("Golden Gate Park");
  await panel.getByPlaceholder("Description").fill("bring cleats");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  await expect(panel.getByPlaceholder("Location")).toHaveValue("Golden Gate Park");
  await expect(panel.getByPlaceholder("Description")).toHaveValue("bring cleats");
});

test("correctness: bare weekday quick-create makes an all-day event", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create");
  await qc.locator("input").fill("laundry saturday");
  await expect(qc.locator(".qc-preview")).toContainText("all day");
  await qc.locator("input").press("Enter");
  await expect(page.locator(".chip-allday", { hasText: "laundry" })).toBeVisible();
});

test("correctness: month chip click opens the panel", async ({ page }) => {
  await open(page);
  await page.keyboard.press("m");
  await page.locator(".mchip", { hasText: "Standup" }).first().click();
  await expect(page.getByTestId("event-panel").locator(".panel-title")).toHaveValue("Standup");
});

test("parity: day view title shows the full date", async ({ page }) => {
  await open(page);
  await page.keyboard.press("1");
  await expect(page.locator(".topbar-title")).toHaveText("October 14, 2026");
});

test("parity: option-drag duplicates instead of moving (Notion)", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const box = (await chip.boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 96, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(1);
});

test("parity: 2-9 keys switch to N-day views", async ({ page }) => {
  await open(page);
  await page.keyboard.press("3");
  await expect(page.locator(".day-head")).toHaveCount(3);
  await expect(page.locator(".day-head").first()).toContainText("14"); // starts at anchor
  await page.keyboard.press("ArrowRight"); // steps by 3 days
  await expect(page.locator(".day-head").first()).toContainText("17");
  await page.keyboard.press("0");
  await expect(page.locator(".day-head")).toHaveCount(7);
});

test("parity: shift+cmd+e hides weekends in week view", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.locator(".day-head")).toHaveCount(5);
  await expect(page.locator(".day-head", { hasText: "Sun" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.locator(".day-head")).toHaveCount(7);
});

test("gesture: hidden-weekend week keeps five business days while panning", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  const headers = page.locator(".day-head");
  await expect(headers).toHaveCount(5);
  const before = await headers.allTextContents();
  expect(before.map((s) => s.trim().slice(0, 3))).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  const clip = await page.locator(".day-headers .pan-clip").boundingBox();
  const grid = await page.getByTestId("week-grid").boundingBox();
  await page.mouse.move(grid!.x + grid!.width / 2, grid!.y + 200);
  await page.mouse.wheel(Math.ceil(clip!.width / 5) + 2, 0);
  await expect.poll(async () => (await headers.allTextContents()).map((s) => s.trim().slice(0, 3)))
    .toEqual(["Tue", "Wed", "Thu", "Fri", "Mon"]);
  await page.mouse.wheel(Math.ceil(clip!.width / 5) * 4, 0);
  await expect.poll(async () => (await headers.allTextContents()).map((s) => s.trim().slice(0, 3)))
    .toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  await expect(headers.first().locator(".dnum")).toHaveText("19");
  await page.mouse.wheel(-Math.ceil(clip!.width / 5) * 5 - 20, 0);
  await expect(headers.first().locator(".dnum")).toHaveText("12");
});

test("gesture: changing visible days clears a partial horizontal pan", async ({ page }) => {
  await open(page);
  const grid = page.getByTestId("week-grid");
  const box = (await grid.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.wheel(40, 0);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(page.locator(".day-head")).toHaveCount(5);
  const first = (await page.locator(".day-head").first().boundingBox())!;
  const clip = (await page.locator(".day-headers .pan-clip").boundingBox())!;
  expect(Math.abs(first.x - clip.x)).toBeLessThan(1);
});

test("gesture: partial horizontal scroll stays put and resumes without springback", async ({ page }) => {
  await open(page);
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  await page.mouse.move(grid.x + grid.width / 2, grid.y + 200);
  const first = page.locator(".day-head").first();
  const start = (await first.boundingBox())!.x;
  await page.mouse.wheel(40, 0);
  const moved = (await first.boundingBox())!.x;
  expect(start - moved).toBeGreaterThan(35);
  await page.waitForTimeout(350);
  expect(Math.abs((await first.boundingBox())!.x - moved)).toBeLessThan(1);
  await page.mouse.wheel(40, 0);
  expect(Math.abs((await first.boundingBox())!.x - (moved - 40))).toBeLessThan(2);
});

test("gesture: a wheel burst uses cached geometry and one transform paint per frame", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const clip = document.querySelector<HTMLElement>(".day-clip")!;
    const strips = [...document.querySelectorAll<HTMLElement>(".pan-strip")];
    let layoutReads = 0;
    let styleWrites = 0;
    const rect = clip.getBoundingClientRect.bind(clip);
    clip.getBoundingClientRect = () => {
      layoutReads++;
      return rect();
    };
    const observers = strips.map((strip) => {
      const observer = new MutationObserver((records) => {
        styleWrites += records.filter((record) => record.attributeName === "style").length;
      });
      observer.observe(strip, { attributes: true, attributeFilter: ["style"] });
      return observer;
    });
    for (let i = 0; i < 50; i++) {
      grid.dispatchEvent(new WheelEvent("wheel", {
        deltaX: 1,
        deltaY: 0,
        bubbles: true,
        cancelable: true,
      }));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observers.forEach((observer) => observer.disconnect());
    return { layoutReads, styleWrites };
  });
  expect(result.layoutReads).toBe(0);
  expect(result.styleWrites).toBeLessThanOrEqual(3);
});

test("gesture: a swipe never paints the old days pulled back a column", async ({ page }) => {
  // At every day boundary the offset used to drop by a whole column before
  // React rendered the shifted days, so one frame showed the previous days
  // jumped back under the pointer: the swipe's jitter.
  await open(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__swipe = [];
    const head = document.querySelector(".day-headers .pan-strip") as HTMLElement;
    const colW = () => (document.querySelector(".day-clip") as HTMLElement).clientWidth /
      document.querySelectorAll(".day-head").length;
    const pos = () => {
      const dnum = Number(head.querySelector(".day-head .dnum")!.textContent);
      const m = /-\s*(-?[\d.]+)px/.exec(head.style.transform);
      return dnum + (m ? Number(m[1]) : 0) / colW();
    };
    w.__swipe.push(pos());
    new MutationObserver(() => w.__swipe.push(pos())).observe(
      document.querySelector("[data-testid=week-grid]")!,
      { childList: true, subtree: true, attributes: true, attributeFilter: ["style"], characterData: true },
    );
  });
  const box = (await page.getByTestId("week-grid").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(14, 0);
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(300);
  const samples: number[] = await page.evaluate(() => (window as any).__swipe);
  const backward = samples.slice(1).filter((x, i) => x - samples[i] < -0.02);
  expect(samples[samples.length - 1] - samples[0]).toBeGreaterThan(2);
  expect(backward).toEqual([]);
});

test("gesture: showing weekends keeps the current first visible day", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+e");
  const headers = page.locator(".day-head");
  const clip = (await page.locator(".day-headers .pan-clip").boundingBox())!;
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  await page.mouse.move(grid.x + grid.width / 2, grid.y + 200);
  await page.mouse.wheel(Math.ceil(clip.width / 5) + 2, 0);
  await expect(headers.first().locator(".dow")).toHaveText("Tue");
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(headers).toHaveCount(7);
  await expect(headers.first().locator(".dow")).toHaveText("Tue");
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(headers).toHaveCount(5);
  await expect(headers.first().locator(".dow")).toHaveText("Tue");
});

test("parity: cmd+c / cmd+v copies an event onto the anchor day", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).click(); // Wed 10:00
  await page.keyboard.press("Escape"); // keep selection
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.getByTestId("toast")).toContainText("Copied");
  await page.keyboard.press("ControlOrMeta+v"); // paste on anchor (today, Wed)
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(1);
});

test("parity: cmd+x cuts and cmd+v pastes elsewhere", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+x");
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(0);
  await page.keyboard.press("j"); // next week
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(1);
});

test("parity: e opens the selected event's editor", async ({ page }) => {
  await open(page);
  await page.keyboard.press("n"); // select first visible
  await page.keyboard.press("e");
  await expect(page.getByTestId("event-panel")).toBeVisible();
});

test("parity: hour zoom with shift+cmd+. and reset with shift+cmd+0", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" }); // 1h event
  const h0 = (await chip.boundingBox())!.height;
  await page.keyboard.press("ControlOrMeta+Shift+."); // zoom in
  const h1 = (await chip.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0);
  await page.keyboard.press("ControlOrMeta+Shift+0"); // reset
  const h2 = (await chip.boundingBox())!.height;
  expect(Math.round(h2)).toBe(Math.round(h0));
  await page.keyboard.press("ControlOrMeta+Shift+,"); // zoom out
  const h3 = (await chip.boundingBox())!.height;
  expect(h3).toBeLessThan(h0);
});

test("parity: x toggles selection of the hovered event", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).hover();
  await page.keyboard.press("x");
  await expect(page.locator(".chip-timed.selected", { hasText: "Standup" })).toHaveCount(1);
  await page.keyboard.press("x");
  await expect(page.locator(".chip-timed.selected")).toHaveCount(0);
});

test("fuzz: deterministic interaction monkey causes no page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page);
  const grid = (await page.getByTestId("week-grid").boundingBox())!;
  // seeded LCG so the sequence is reproducible
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const keys = ["t", "w", "m", "l", "d", "j", "k", "n", "b", "Escape", "2", "0", "`", "`"];
  for (let i = 0; i < 40; i++) {
    const r = rnd();
    if (r < 0.4) {
      const x = grid.x + 20 + rnd() * (grid.width - 40);
      const y = grid.y + 20 + rnd() * Math.min(grid.height - 40, 600);
      if (rnd() < 0.5) {
        await page.mouse.click(x, y);
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + (rnd() - 0.5) * 300, y + (rnd() - 0.5) * 200, { steps: 3 });
        await page.mouse.up();
      }
      // may have opened a panel over the grid; dismiss sometimes
      if (rnd() < 0.5) await page.keyboard.press("Escape");
    } else {
      await page.keyboard.press(keys[Math.floor(rnd() * keys.length)]);
    }
    // return to a time-grid view if we wandered off
    if (i % 10 === 9) {
      await page.keyboard.press("Escape");
      await page.keyboard.press("0");
    }
  }
  expect(errors).toEqual([]);
});

// --- iteration 6: cross-midnight editing, DST week, scroll-to-selection ---

test("bug: editing a cross-midnight event preserves its next-day end", async ({ page }) => {
  await open(page);
  // make Swim cross midnight (Fri 18-20 -> Fri 23-01)
  const chip = page.locator(".chip-timed", { hasText: "Swim" });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 5 * 48, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".chip-timed", { hasText: "Swim" })).toHaveCount(2);
  // open it and rename WITHOUT touching times; end must stay next-day
  await page.locator(".chip-timed", { hasText: "Swim" }).first().click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.locator(".panel-nextday")).toBeVisible();
  await panel.locator(".panel-title").fill("Swim night");
  await panel.getByRole("button", { name: /Save/ }).click();
  await expect(page.locator(".chip-timed", { hasText: "Swim night" })).toHaveCount(2);
});

test("correctness: DST fall-back week renders sanely", async ({ page }) => {
  await page.goto(`/?now=${encodeURIComponent("2026-11-01T09:00:00")}`); // DST ends Nov 1 2026
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.locator(".day-head.today .dnum")).toHaveText("1");
  // creating an afternoon event lands at the wall-clock hour
  const col = page.getByTestId("day-col-0");
  const box = (await col.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 14 * 48);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 15 * 48, { steps: 4 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  await expect(panel.locator('input[type="time"]').first()).toHaveValue("14:00");
  await page.keyboard.press("Escape");
});

test("parity: n-selection scrolls the chip into view", async ({ page }) => {
  await open(page);
  const grid = page.getByTestId("week-grid");
  // cycle selection a few times; the selected chip must always be on-screen
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("n");
    const sel = page.locator(".chip-timed.selected");
    if ((await sel.count()) === 1) {
      const sb = (await sel.boundingBox())!;
      const gb = (await grid.boundingBox())!;
      expect(sb.y + sb.height).toBeGreaterThan(gb.y);
      expect(sb.y).toBeLessThan(gb.y + gb.height);
    }
  }
});

// --- iteration 7 ---

test("bug: mini-month follows main navigation", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j"); // next week (crosses into week of Oct 18)
  await page.keyboard.press("j");
  await page.keyboard.press("j"); // week of Nov 1
  await expect(page.getByTestId("mini-month").locator(".mini-title")).toHaveText("November 2026");
  await page.keyboard.press("t");
  await expect(page.getByTestId("mini-month").locator(".mini-title")).toHaveText("October 2026");
});

test("parity: title shows a range when the view spans months", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j");
  await page.keyboard.press("j"); // Oct 25 - 31 week
  await page.keyboard.press("j"); // Nov 1-7
  await expect(page.locator(".topbar-title")).toHaveText("November 2026");
  await page.keyboard.press("k"); // Oct 25 – Nov... wait, Oct 25-31 stays Oct
  await expect(page.locator(".topbar-title")).toHaveText("October 2026");
  // a 9-day view starting Oct 28 spans Oct–Nov
  await page.keyboard.press("t");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk [cmdk-input]").fill("oct 28");
  await page.locator(".cmdk").getByText(/Go to .*October 28/).click();
  await page.keyboard.press("9");
  await expect(page.locator(".topbar-title")).toHaveText("Oct – Nov 2026");
});

test("correctness: DST spring-forward day drag lands on wall-clock time", async ({ page }) => {
  await page.goto(`/?now=${encodeURIComponent("2027-03-14T09:00:00")}`); // US spring forward 2027
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  const col = page.getByTestId("day-col-0"); // Sunday Mar 14
  const box = (await col.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 14 * 48);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 15 * 48, { steps: 4 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  await expect(panel.locator('input[type="time"]').first()).toHaveValue("14:00");
  await page.keyboard.press("Escape");
});

// --- iteration 8: cross-midnight continuation segment drags ---

async function makeSwimCrossMidnight(page: import("@playwright/test").Page) {
  const chip = page.locator(".chip-timed", { hasText: "Swim" });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 5 * 48, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".chip-timed", { hasText: "Swim" })).toHaveCount(2);
  // the after-midnight segment sits at the top of the grid: scroll to it so
  // synthetic pointer coordinates stay inside the viewport
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 0));
}

test("bug: moving the after-midnight segment moves the event, not +24h", async ({ page }) => {
  await open(page);
  await makeSwimCrossMidnight(page); // Fri 23:00 – Sat 01:00
  const seg2 = page.locator(".chip-timed", { hasText: "Swim" }).nth(1); // Saturday 00:00-01:00
  const box = (await seg2.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 24, { steps: 4 }); // +30min
  await page.mouse.up();
  // event is now Fri 23:30 – Sat 01:30: still two segments, start on Friday
  await expect(page.locator(".chip-timed", { hasText: "Swim" })).toHaveCount(2);
  await page.locator(".chip-timed", { hasText: "Swim" }).first().click();
  const panel = page.getByTestId("event-panel");
  expect(await panelDateValue(panel)).toBe("2026-10-16"); // Friday
  await expect(panel.locator('input[type="time"]').first()).toHaveValue("23:30");
  await expect(panel.locator('input[type="time"]').nth(1)).toHaveValue("01:30");
  await expect(panel.locator(".panel-nextday")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("bug: resizing the after-midnight segment does not add 24 hours", async ({ page }) => {
  await open(page);
  await makeSwimCrossMidnight(page); // Fri 23:00 – Sat 01:00
  const seg2 = page.locator(".chip-timed", { hasText: "Swim" }).nth(1);
  const box = (await seg2.boundingBox())!;
  // drag the bottom resize edge down one hour (01:00 -> 02:00)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3 + 48, { steps: 4 });
  await page.mouse.up();
  await page.locator(".chip-timed", { hasText: "Swim" }).first().click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.locator('input[type="time"]').first()).toHaveValue("23:00");
  await expect(panel.locator('input[type="time"]').nth(1)).toHaveValue("02:00");
  await expect(panel.locator(".panel-nextday")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("bug: unchecking all-day defaults to a morning block, not midnight", async ({ page }) => {
  await open(page);
  await page.locator(".chip-allday", { hasText: "Offsite" }).first().click();
  const panel = page.getByTestId("event-panel");
  await panel.getByRole("button", { name: "All-day" }).click(); // toggle off
  await expect(panel.locator('input[type="time"]').first()).toHaveValue("09:00");
  await expect(panel.locator('input[type="time"]').nth(1)).toHaveValue("10:00");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.keyboard.press("j"); // Offsite is Thu/Fri this week; stay put actually
  await page.keyboard.press("k");
  await expect(page.locator(".chip-timed", { hasText: "Offsite" })).toBeVisible();
});

test("parity: shift+N selects previous like b", async ({ page }) => {
  await open(page);
  await page.keyboard.press("n");
  await page.keyboard.press("n");
  const second = await page.locator(".chip-timed.selected .chip-title").textContent();
  await page.keyboard.press("Shift+N");
  const back = await page.locator(".chip-timed.selected .chip-title").textContent();
  expect(back).not.toBe(second);
});

test("parity: secondary time zone column via command menu, persisted", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk [cmdk-input]").fill("time zone");
  await page.locator(".cmdk").getByText("Tokyo").click();
  await expect(page.locator(".hour-label-2")).toHaveCount(23);
  // Tokyo is UTC+9: the 9 AM local (EDT, UTC-4) row shows 10 PM Tokyo
  const local9 = page.locator(".hour-label:not(.hour-label-2)", { hasText: /^9 AM$/ });
  await expect(local9).toHaveCount(1);
  const row9 = page.locator(".hour-label-2").nth(8); // 9th hour
  await expect(row9).toHaveText(/10\s?PM/);
  // persists across reload
  await page.reload();
  await expect(page.locator(".hour-label-2")).toHaveCount(23);
  // and None removes it
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk [cmdk-input]").fill("time zone");
  await page.locator(".cmdk").getByText("None").click();
  await expect(page.locator(".hour-label-2")).toHaveCount(0);
});

test("correctness: undo stack unwinds multiple operations in order", async ({ page }) => {
  await open(page);
  // three identical-time creations collapse into a cluster block (by design),
  // so the undo ladder is observed through the block's rows
  for (const title of ["qa-a", "qa-b", "qa-c"]) {
    await page.keyboard.press("c");
    await page.getByTestId("quick-create").locator("input").fill(`${title} today 9pm`);
    await page.getByTestId("quick-create").locator("input").press("Enter");
  }
  const rows = page.locator(".cluster-row, .chip-timed").filter({ hasText: "qa-" });
  await expect(rows).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows.filter({ hasText: "qa-c" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows.filter({ hasText: "qa-b" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows).toHaveCount(0);
});

test("docked editor never overflows the viewport", async ({ page }) => {
  await open(page);
  const col = page.getByTestId("day-col-6"); // Saturday, rightmost
  const box = (await col.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 15.75 * 48; // 3:45 PM: empty grid
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 24, { steps: 4 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  const pb = (await panel.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(pb.x + pb.width).toBeLessThanOrEqual(vw);
  await page.keyboard.press("Escape");
});

test("parity: quick create parses recurrence (every weekday)", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create");
  await qc.locator("input").fill("standup every weekday 9:30am");
  await expect(qc.locator(".qc-preview")).toContainText("repeats every weekday");
  await expect(qc.locator(".qc-preview")).toContainText("9:30");
  await qc.locator("input").press("Enter");
  // hasText is case-insensitive and also matches the mock's "Standup"
  await expect(page.locator(".chip-timed", { hasText: "standup" })).toHaveCount(2);
});

test("parity: quick create 'every tuesday' anchors the first occurrence", async ({ page }) => {
  await open(page);
  await page.keyboard.press("c");
  const qc = page.getByTestId("quick-create");
  await qc.locator("input").fill("guitar practice every tuesday 7pm");
  await expect(qc.locator(".qc-preview")).toContainText("repeats every tuesday");
  await expect(qc.locator(".qc-preview")).toContainText(/Tue/);
  await page.keyboard.press("Escape");
});

test("parity: delete series removes all instances (context menu)", async ({ page }) => {
  await open(page);
  const sleepChips = page
    .locator(".chip-timed")
    .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  await expect(sleepChips).toHaveCount(2);
  await page
    .locator(".chip-timed:not(.chip-cfull)")
    .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) })
    .click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: "Delete series" }).click();
  await expect(sleepChips).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Deleted series");
});

test("parity: delete series from the event panel via the scope dialog", async ({ page }) => {
  await open(page);
  await page
    .locator(".chip-timed:not(.chip-cfull)")
    .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) })
    .click();
  await page.getByTestId("event-panel").getByRole("button", { name: "Delete" }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(
    page
      .locator(".chip-timed")
      .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) }),
  ).toHaveCount(0);
  await expect(page.getByTestId("event-panel")).toHaveCount(0);
});

test("fuzz: second seed with month/list wandering causes no page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await open(page);
  let seed = 1337;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const keys = ["m", "l", "w", "3", "j", "k", "n", "x", "e", "Escape", "t", "ControlOrMeta+z"];
  for (let i = 0; i < 60; i++) {
    const r = rnd();
    if (r < 0.35) {
      const vp = page.viewportSize()!;
      const x = 240 + rnd() * (vp.width - 260);
      const y = 60 + rnd() * (vp.height - 80);
      if (rnd() < 0.3) await page.mouse.click(x, y, { button: rnd() < 0.5 ? "left" : "right" });
      else await page.mouse.dblclick(x, y);
      if (rnd() < 0.5) await page.keyboard.press("Escape");
    } else {
      await page.keyboard.press(keys[Math.floor(rnd() * keys.length)]);
    }
  }
  expect(errors).toEqual([]);
});

test("parity: dragging a timed event onto the all-day lane converts it", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const box = (await chip.boundingBox())!;
  const lane = (await page.getByTestId("allday-row").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, lane.y + lane.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".chip-allday", { hasText: "Morning run" })).toBeVisible();
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("all-day");
  await page.keyboard.press("ControlOrMeta+z"); // undo restores the timed event
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(1);
});

test("parity: all-day lane is always visible in week view", async ({ page }) => {
  await open(page);
  // hide the Work calendar so only timed events remain, lane must persist
  await page.locator(".cal-row", { hasText: "Work" }).click();
  await expect(page.getByTestId("allday-row")).toBeVisible();
});

test("parity: dragging an all-day chip into the grid schedules it (1h)", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-allday", { hasText: "Offsite" }).first(); // Thu
  const box = (await chip.boundingBox())!;
  const col = page.getByTestId("day-col-4"); // Thursday column
  const colBox = (await col.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(colBox.x + colBox.width / 2, colBox.y + 15 * 48, { steps: 8 }); // 3pm
  await page.mouse.up();
  const timed = page.locator(".chip-timed", { hasText: "Offsite" });
  await expect(timed).toHaveCount(1);
  await expect(timed.locator(".chip-time")).toHaveText("3 – 4 PM");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-allday", { hasText: "Offsite" }).first()).toBeVisible();
});

test("parity: dragging an all-day chip along the lane moves its day", async ({ page }) => {
  await open(page);
  // Offsite spans Thu-Fri (2 days). Drag its Thursday chip to Sunday.
  const chip = page.locator(".chip-allday", { hasText: "Offsite" }).first();
  const box = (await chip.boundingBox())!;
  const lane = (await page.getByTestId("allday-row").boundingBox())!;
  const col0 = (await page.getByTestId("day-col-0").boundingBox())!; // Sunday x
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(col0.x + col0.width / 2, lane.y + lane.height / 2, { steps: 8 });
  await page.mouse.up();
  // now spans Sun-Mon: chips on day cols 0 and 1
  await expect(page.locator(".chip-allday", { hasText: "Offsite" })).toHaveCount(2);
  await page.locator(".chip-allday", { hasText: "Offsite" }).first().click();
  expect(await panelDateValue(page.getByTestId("event-panel"))).toBe("2026-10-11"); // Sunday
  await page.keyboard.press("Escape");
});

// --- user-reported polish: drag/selection colors stay in the event's calendar color ---

test("bug: resize/move ghost keeps the event's calendar color, not blue", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Standup" }); // Work green
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 4 });
  const ghost = page.locator(".chip-ghost");
  await expect(ghost).toBeVisible();
  // normalized Work green: still green-dominant, never the focus blue
  const cal = await ghost.evaluate((el) => getComputedStyle(el).getPropertyValue("--cal").trim());
  const v = parseInt(cal.slice(1), 16);
  expect((v >> 8) & 255).toBeGreaterThan((v >> 16) & 255); // g > r
  expect((v >> 8) & 255).toBeGreaterThan(v & 255); // g > b
  await page.keyboard.press("Escape");
  await page.mouse.up();
});

test("bug: selected chips have no outline ring (tint + elevation only)", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Standup" }).hover();
  await page.keyboard.press("x");
  const sel = page.locator(".chip-timed.selected");
  const shadow = await sel.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toContain("79, 140, 255"); // no focus-blue
  // no 2px spread ring — only the inset bar and a soft drop shadow
  expect(/0px 0px 0px 2px/.test(shadow)).toBe(false);
});

// --- read-only calendars + recurring edit scope (user-reported) ---

test("readonly: subscribed-calendar events cannot be dragged", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j"); // Columbus Day Seminar is on Thu this week? it's at(1,11) = Thu Oct 15
  await page.keyboard.press("k");
  const chip = page.locator(".chip-timed", { hasText: "Columbus Day Seminar" });
  await expect(chip).toHaveClass(/readonly/);
  const before = await chip.locator(".chip-time").textContent();
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 96, { steps: 5 });
  await page.mouse.up();
  await expect(chip.locator(".chip-time")).toHaveText(before!); // unmoved
});

test("readonly: panel is view-only with a notice; no resize handle", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Columbus Day Seminar" });
  await expect(chip.locator(".chip-resize")).toHaveCount(0);
  await chip.click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.getByTestId("panel-readonly")).toBeVisible();
  await expect(panel.getByRole("button", { name: /Save/ })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(panel.locator('input[type="time"]').first()).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("readonly: backspace delete is refused with a toast", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Columbus Day Seminar" }).hover();
  await page.keyboard.press("x"); // select via hover
  await page.keyboard.press("Backspace");
  await expect(page.locator(".chip-timed", { hasText: "Columbus Day Seminar" })).toBeVisible();
  await expect(page.getByTestId("toast")).toContainText("read-only");
});

test("recurring: drag-move asks for scope; 'this event' moves one instance", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 4 * 48));
  // drag the Saturday (plain chip) instance down an hour
  const plain = page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  const box = (await plain.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 48, { steps: 5 });
  await page.mouse.up();
  const dialog = page.getByTestId("scope-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("scope-this").click();
  // Saturday moved to 5-2, Friday's C-shape untouched at 4-1
  await expect(plain.locator(".chip-time")).toHaveText("5 AM – 2 PM");
  await expect(page.getByTestId("cshape-seg").filter({ hasText: "Sleep" })).toHaveAttribute(
    "title",
    /4 AM – 1 PM/,
  );
});

test("recurring: 'all events' shifts every instance's time", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 4 * 48));
  // drag the Saturday (plain) instance; the Friday one renders as a C-shape
  const plain = page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  const box = (await plain.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 48, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(plain.locator(".chip-time")).toHaveText("5 AM – 2 PM");
  // the C-shape carries the new range in its tooltip title
  await expect(page.getByTestId("cshape-seg").filter({ hasText: "Sleep" })).toHaveAttribute(
    "title",
    /5 AM – 2 PM/,
  );
  await expect(page.getByTestId("toast")).toContainText("Updated all");
});

test("recurring: 'all events' moves the whole series to the chosen calendar", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 4 * 48));
  const sleep = page.locator(".chip-timed:not(.chip-cfull)").filter({
    has: page.locator(".chip-title", { hasText: /^Sleep$/ }),
  });
  await sleep.click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-cal-trigger").click();
  await panel.getByTestId("panel-cal-options").getByRole("option", { name: "Work" }).click();
  await expect(panel.getByTestId("panel-cal-trigger")).toContainText("Work");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  await expect(sleep).toHaveCSS("--cal", "#2fbf71");
  await expect(page.getByTestId("cshape-seg").filter({ hasText: "Sleep" }))
    .toHaveCSS("--cal", "#2fbf71");
  await sleep.click();
  await expect(page.getByTestId("event-panel").getByTestId("panel-cal-trigger"))
    .toContainText("Work");
});

test("recurring: 'all events' saves guests, busy, visibility, and reminders", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 4 * 48));
  const saturday = page.locator(".chip-timed:not(.chip-cfull)").filter({
    has: page.locator(".chip-title", { hasText: /^Sleep$/ }),
  });
  await saturday.click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-inline-select").nth(0).selectOption("transparent");
  await panel.locator(".panel-inline-select").nth(1).selectOption("private");
  await panel.locator(".panel-section .panel-cal").last().selectOption("30");
  await panel.locator(".panel-attendee-input").fill("qa-test@example.invalid");
  await panel.locator(".panel-attendee-input").press("Enter");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  await expect(panel).toHaveCount(0);
  const friday = page.getByTestId("cshape-seg").filter({ hasText: "Sleep" });
  for (const chip of [saturday, friday]) {
    await chip.click(chip === friday ? { position: { x: 10, y: 15 } } : {});
    await expect(panel.locator(".panel-section .panel-cal").last()).toHaveValue("30");
    await expect(panel.locator(".panel-inline-select").nth(0)).toHaveValue("transparent");
    await expect(panel.locator(".panel-inline-select").nth(1)).toHaveValue("private");
    await expect(panel.locator(".panel-attendee")).toContainText("qa-test@example.invalid");
    await page.keyboard.press("Escape");
  }
});

test("recurring: 'all events' shifts every all-day occurrence", async ({ page }) => {
  const fixture = {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: ["2026-10-15", "2026-10-16"].map((start, i) => ({
      id: `all-day-${i}`, calendar_id: "primary", etag: null, summary: "All-day series",
      description: null, location: null, start, end: i === 0 ? "2026-10-16" : "2026-10-17",
      all_day: true, timezone: null, status: "confirmed", recurrence: null,
      recurring_event_id: "all-day-master", conference_url: null, updated: null, raw: null,
    })),
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await open(page);
  const row = page.getByTestId("allday-row");
  await row.locator(".allday-cell").nth(4).getByRole("button", { name: "All-day series" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-date-pretty").click();
  await panel.locator('input[type="date"]:not(.allday-end)').fill("2026-10-16");
  await panel.locator('input[type="date"]:not(.allday-end)').blur();
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  await expect(row.locator(".allday-cell").nth(4).getByRole("button", { name: "All-day series" })).toHaveCount(0);
  await expect(row.locator(".allday-cell").nth(5).getByRole("button", { name: "All-day series" })).toHaveCount(1);
  await expect(row.locator(".allday-cell").nth(6).getByRole("button", { name: "All-day series" })).toHaveCount(1);
});

test("recurring: 'all events' converts timed occurrences to all-day", async ({ page }) => {
  const fixture = {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: ["2026-10-15", "2026-10-16"].map((date, i) => ({
      id: `mode-${i}`, calendar_id: "primary", etag: null, summary: "Mode series",
      description: null, location: null, start: `${date}T09:00:00-04:00`,
      end: `${date}T10:00:00-04:00`, all_day: false, timezone: "America/New_York",
      status: "confirmed", recurrence: null, recurring_event_id: "mode-master",
      conference_url: null, updated: null, raw: null,
    })),
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await open(page);
  await page.locator(".chip-timed", { hasText: "Mode series" }).first().click();
  await page.getByTestId("event-panel").getByRole("button", { name: "All-day" }).click();
  await page.getByTestId("event-panel").getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  await expect(page.locator(".chip-timed", { hasText: "Mode series" })).toHaveCount(0);
  await expect(page.getByTestId("allday-row").getByRole("button", { name: "Mode series" })).toHaveCount(2);
});

test("recurring: 'all events' converts all-day occurrences to timed", async ({ page }) => {
  const fixture = {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: ["2026-10-15", "2026-10-16"].map((start, i) => ({
      id: `mode-${i}`, calendar_id: "primary", etag: null, summary: "Mode series",
      description: null, location: null, start, end: i === 0 ? "2026-10-16" : "2026-10-17",
      all_day: true, timezone: null, status: "confirmed", recurrence: null,
      recurring_event_id: "mode-master", conference_url: null, updated: null, raw: null,
    })),
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await open(page);
  await page.getByTestId("allday-row").getByRole("button", { name: "Mode series" }).first().click();
  await page.getByTestId("event-panel").getByRole("button", { name: "All-day" }).click();
  await page.getByTestId("event-panel").getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  await expect(page.getByTestId("allday-row").getByRole("button", { name: "Mode series" })).toHaveCount(0);
  await expect(page.locator(".chip-timed", { hasText: "Mode series" })).toHaveCount(2);
});

test("recurring: moving a later timed occurrence with 'all events' shifts the series dates", async ({ page }) => {
  const fixture = {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: ["2026-10-15", "2026-10-16"].map((date, i) => ({
      id: `shift-${i}`, calendar_id: "primary", etag: null, summary: "Shift series",
      description: null, location: null, start: `${date}T09:00:00-04:00`,
      end: `${date}T10:00:00-04:00`, all_day: false, timezone: "America/New_York",
      status: "confirmed", recurrence: null, recurring_event_id: "shift-master",
      conference_url: null, updated: null, raw: null,
    })),
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await open(page);
  await page.locator(".chip-timed", { hasText: "Shift series" }).last().click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-date-pretty").click();
  await panel.locator('input[type="date"]:not(.allday-end)').fill("2026-10-17");
  await panel.locator('input[type="date"]:not(.allday-end)').blur();
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  await expect(page.getByTestId("day-col-4").locator(".chip-timed", { hasText: "Shift series" })).toHaveCount(0);
  await expect(page.getByTestId("day-col-5").locator(".chip-timed", { hasText: "Shift series" })).toHaveCount(1);
  await expect(page.getByTestId("day-col-6").locator(".chip-timed", { hasText: "Shift series" })).toHaveCount(1);
});

test("recurring: 'all events' never copies one occurrence's note onto the series", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 4 * 48));
  // the plain (non C-shape) occurrence gets a note of its own
  const plain = page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  const key = (await plain.getAttribute("data-ek"))!;
  await page.evaluate(async (k) => {
    const cut = k.lastIndexOf("/");
    await (window as any).__mockBackend.setEventNote(k.slice(0, cut), k.slice(cut + 1), "Only this night.");
  }, key);
  await plain.click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.getByTestId("panel-drill")).toContainText("Only this night.");
  await panel.locator(".panel-title").fill("Sleep (renamed)");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all");
  const descriptions: (string | null)[] = await page.evaluate(async () => {
    const all = await (window as any).__mockBackend.listEvents("2026-10-01", "2026-11-01");
    return all.filter((e: any) => e.recurring_event_id === "sleep-master").map((e: any) => e.description);
  });
  expect(descriptions.filter((d) => d?.includes("Only this night."))).toHaveLength(1);
});

test("recurring: the scope dialog opens before the series master has loaded", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 4 * 48));
  // a slow Google round trip for the master
  await page.evaluate(() => {
    const b = (window as any).__mockBackend;
    const get = b.getSeriesMaster;
    b.getSeriesMaster = (...a: unknown[]) => new Promise((r) => setTimeout(() => r(get(...a)), 1500));
  });
  const sleep = page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  await sleep.click();
  await page.getByTestId("event-panel").locator(".panel-title").fill("Sleep (later)");
  await page.getByTestId("event-panel").getByRole("button", { name: /Save/ }).click();
  await expect(page.getByTestId("scope-dialog")).toBeVisible({ timeout: 500 });
  await page.getByTestId("scope-dialog").getByTestId("scope-all").click();
  await expect(page.getByTestId("toast")).toContainText("Updated all", { timeout: 4000 });
});

test("recurring: delete 'this and following' truncates the series", async ({ page }) => {
  await open(page);
  // the two recurring Sleep instances render as a C-shape (Fri) + a chip (Sat)
  const exact = page
    .locator(".chip-timed")
    .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  await expect(exact).toHaveCount(2);
  const sat = page
    .locator(".chip-timed:not(.chip-cfull)")
    .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  await sat.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: "Delete", exact: false }).first().click();
  const dialog = page.getByTestId("scope-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("scope-following").click();
  await expect(exact).toHaveCount(1); // Friday remains
});

test("recurring: editing 'this and following' keeps the remaining COUNT", async ({ page }) => {
  const rule = "RRULE:FREQ=DAILY;COUNT=3";
  const fixture = {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: ["2026-10-15", "2026-10-16", "2026-10-17"].map((date, i) => ({
      id: `split-${i}`, calendar_id: "primary", etag: null, summary: "Split series",
      description: null, location: null, start: `${date}T09:00:00-04:00`,
      end: `${date}T10:00:00-04:00`, all_day: false, timezone: "America/New_York",
      status: "confirmed", recurrence: null, recurring_event_id: "split-master",
      conference_url: null, updated: null,
      raw: { masterRecurrence: [rule], originalStartTime: { dateTime: `${date}T09:00:00-04:00` } },
    })),
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await open(page);
  await page.locator(".chip-timed", { hasText: "Split series" }).nth(1).click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("Split edited");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.getByTestId("toast")).toContainText("and following");
  const result = await page.evaluate(async () => {
    const moduleUrl = performance.getEntriesByType("resource")
      .map((entry) => entry.name).find((url) => url.includes("/src/lib/mockBackend.ts"));
    if (!moduleUrl) throw new Error("mock backend module not loaded");
    const { mockBackend } = await import(/* @vite-ignore */ moduleUrl);
    const rows = await mockBackend.listEvents("2026-10-14", "2026-10-20");
    return {
      old: rows.filter((event) => event.recurring_event_id === "split-master").map((event) => event.id),
      newRule: rows.find((event) => event.summary === "Split edited")?.recurrence?.[0],
    };
  });
  expect(result.old).toEqual(["split-0"]);
  expect(result.newRule).toBe("RRULE:FREQ=DAILY;COUNT=2");
});

test("recurring: deleting 'this and following' works for a COUNT series", async ({ page }) => {
  const fixture = {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: ["2026-10-15", "2026-10-16", "2026-10-17"].map((date, i) => ({
      id: `count-delete-${i}`, calendar_id: "primary", etag: null, summary: "Count delete",
      description: null, location: null, start: `${date}T09:00:00-04:00`,
      end: `${date}T10:00:00-04:00`, all_day: false, timezone: "America/New_York",
      status: "confirmed", recurrence: null, recurring_event_id: "count-delete-master",
      conference_url: null, updated: null,
      raw: { masterRecurrence: ["RRULE:FREQ=DAILY;COUNT=3"] },
    })),
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await open(page);
  const chips = page.locator(".chip-timed", { hasText: "Count delete" });
  await expect(chips).toHaveCount(3);
  await chips.nth(1).click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: "Delete", exact: false }).first().click();
  const following = page.getByTestId("scope-dialog").getByTestId("scope-following");
  await expect(following).toBeEnabled();
  await following.click();
  await expect(chips).toHaveCount(1);
});

test("recurring: 'this and following' from the first occurrence updates the master", async ({ page }) => {
  const fixture = {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: ["2026-10-15", "2026-10-16"].map((date, i) => ({
      id: `first-${i}`, calendar_id: "primary", etag: null, summary: "First series",
      description: null, location: null, start: `${date}T09:00:00-04:00`,
      end: `${date}T10:00:00-04:00`, all_day: false, timezone: "America/New_York",
      status: "confirmed", recurrence: null, recurring_event_id: "first-master",
      conference_url: null, updated: null,
      raw: { masterRecurrence: ["RRULE:FREQ=DAILY;COUNT=2"] },
    })),
  };
  await page.addInitScript((fx) => { (globalThis as any).__calFixture = fx; }, fixture);
  await open(page);
  await page.locator(".chip-timed", { hasText: "First series" }).first().click();
  const panel = page.getByTestId("event-panel");
  await panel.locator(".panel-title").fill("First edited");
  await panel.getByRole("button", { name: /Save/ }).click();
  await page.getByTestId("scope-dialog").getByTestId("scope-following").click();
  await expect(page.locator(".chip-timed", { hasText: "First edited" })).toHaveCount(2);
});

test("recurring: escape cancels the scope dialog without changes", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 4 * 48));
  const chips = page.locator(".chip-timed:not(.chip-cfull)").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  const before = await chips.first().locator(".chip-time").textContent();
  const box = (await chips.first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 48, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("scope-dialog")).toBeVisible();
  await page.getByTestId("scope-dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(chips.first().locator(".chip-time")).toHaveText(before!);
});

// --- multi-select (user-requested; Notion catalog: shift/cmd click, shift drag, cmd+A) ---

test("multiselect: shift-click builds a selection; backspace deletes all; undo restores", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click({ modifiers: ["Shift"] });
  await page.locator(".chip-timed", { hasText: "Standup" }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".chip-timed.selected")).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(0);
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Deleted 2 events");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(1);
  await expect(page.locator(".chip-timed", { hasText: "Standup" })).toHaveCount(1);
});

test("multiselect: shift-click again removes from the selection", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click({ modifiers: ["Shift"] });
  await page.locator(".chip-timed", { hasText: "Standup" }).click({ modifiers: ["Shift"] });
  await page.locator(".chip-timed", { hasText: "Standup" }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".chip-timed.selected")).toHaveCount(1);
});

test("multiselect: cmd+A selects all visible events", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+a");
  const chips = await page.locator(".chip-timed").count();
  const selected = await page.locator(".chip-timed.selected").count();
  expect(selected).toBe(chips);
  await expect(page.getByTestId("toast")).toContainText("Selected");
});

test("multiselect: shift-drag marquee selects intersecting events", async ({ page }) => {
  await open(page);
  // marquee over Wednesday 1:30-10:30 catches Morning run (7-8) and Standup (10-10:15)
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 0));
  const col = page.getByTestId("day-col-3");
  const box = (await col.boundingBox())!;
  const x = box.x + box.width / 2;
  await page.keyboard.down("Shift");
  await page.mouse.move(x, box.y + 1.5 * 48);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 10.5 * 48, { steps: 6 });
  await expect(page.getByTestId("marquee")).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".chip-timed.selected")).toHaveCount(2);
  await expect(page.locator(".chip-timed.selected", { hasText: "Morning run" })).toHaveCount(1);
  await expect(page.locator(".chip-timed.selected", { hasText: "Standup" })).toHaveCount(1);
});

test("multiselect: dragging one selected chip moves the whole group", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click({ modifiers: ["Shift"] });
  await page.locator(".chip-timed", { hasText: "Standup" }).click({ modifiers: ["Shift"] });
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 10 + 96, { steps: 5 }); // +2h
  await page.mouse.up();
  await expect(chip.locator(".chip-time")).toHaveText("9 – 10 AM");
  // Standup moved by the same delta (10:00 -> 12:00); 15-min chip shows no time, verify via panel
  await page.locator(".chip-timed", { hasText: "Standup" }).click();
  await expect(page.getByTestId("event-panel").locator('input[type="time"]').first()).toHaveValue("12:00");
  await expect(page.getByTestId("toast").or(page.locator(".toast"))).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z"); // undo group move
  await page.locator(".chip-timed", { hasText: "Standup" }).click();
  await expect(page.getByTestId("event-panel").locator('input[type="time"]').first()).toHaveValue("10:00");
});

test("multiselect: bulk delete skips read-only events with a note", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click({ modifiers: ["Shift"] });
  await page.locator(".chip-timed", { hasText: "Columbus Day Seminar" }).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Backspace");
  await expect(page.locator(".chip-timed", { hasText: "Columbus Day Seminar" })).toHaveCount(1);
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("read-only skipped");
});

// --- calendar colors: exactly what Google Calendar shows, tinted by the chip ---

test("colors: calendars wear the exact color Google Calendar shows, tinted translucent", async ({ page }) => {
  await open(page);
  const chip = (title: string) => page.locator(".chip-timed", { hasText: title });
  const calOf = (title: string) => chip(title).evaluate((el) => getComputedStyle(el).getPropertyValue("--cal").trim());
  const graphite = await calOf("Deep work block"); // Google's Graphite #616161
  const cocoa = await calOf("Laundry + dishes"); // Google's Cocoa #795548
  expect(graphite).toBe("#616161");
  expect(cocoa).toBe("#795548"); // brown, as Google paints it
  expect(graphite).not.toBe(cocoa);
  // the body is a tint of it over the page, never the solid color
  const bg = await chip("Laundry + dishes").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toMatch(/^rgb\(121, 85, 72\)$/);
});

test("colors: hue identity is preserved (green stays green)", async ({ page }) => {
  await open(page);
  const work = await page
    .locator(".chip-timed", { hasText: "Standup" })
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--cal").trim());
  const v = parseInt(work.slice(1), 16);
  const r = (v >> 16) & 255,
    g = (v >> 8) & 255,
    b = v & 255;
  expect(g).toBeGreaterThan(r); // still green-dominant
  expect(g).toBeGreaterThan(b);
});

// visual snapshots of the editor itself — behavior tests alone let an ugly
// panel ship once; never again
test("visual: new-event editor matches snapshot", async ({ page }) => {
  await open(page);
  const col = page.getByTestId("day-col-1");
  const box = (await col.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 13 * 48);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 14 * 48, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await expect(page.getByTestId("event-panel")).toHaveScreenshot("panel-new.png", {
    maxDiffPixelRatio: 0.005,
    threshold: 0.05,
  });
});

test("visual: view-event editor matches snapshot", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await expect(page.getByTestId("event-panel")).toHaveScreenshot("panel-view.png", {
    maxDiffPixelRatio: 0.005,
    threshold: 0.05,
  });
});

// --- layered overlap layout: every overlap is a C-shaped slab stack ---

test("cshape: a fully-covered slab claims a title band and pushes children below it", async ({ page }) => {
  await open(page);
  // Monday's 'Admin block' is 100% covered by emails/forms/follow-ups:
  // no time gap fits its label, so it takes a 16px band and the first child
  // slides down under it - title readable, nothing sliced
  const slab = page.locator('[title^="Admin block ("]');
  await expect(slab).toHaveCount(1);
  await expect(slab.locator(".chip-title")).toHaveText("Admin block");
  const child = page.locator(".chip-timed", { hasText: "emails" });
  const childBox = (await child.boundingBox())!;
  const slabBox = (await slab.boundingBox())!;
  const col = (await page.getByTestId("day-col-1").boundingBox())!;
  expect(slabBox.width).toBeGreaterThan(col.width * 0.9);
  expect(childBox.y).toBeGreaterThanOrEqual(slabBox.y + 14);
  expect(childBox.x - slabBox.x).toBeGreaterThanOrEqual(18);
  expect(childBox.width).toBeGreaterThan(col.width * 0.8);
});

test("cshape: identical-interval events stack like cards, both titles visible", async ({ page }) => {
  await open(page);
  // Sunday: Reading group and Paper skim are both 3-4 PM; no columns - the
  // later one paints on top, pushed down one title band
  const slab = page.locator('[title^="Reading group ("]');
  const top = page.locator(".chip-timed:not(.chip-cfull)", { hasText: "Paper skim" });
  await expect(slab.locator(".chip-title")).toHaveText("Reading group");
  const col = (await page.getByTestId("day-col-0").boundingBox())!;
  const slabBox = (await slab.boundingBox())!;
  const topBox = (await top.boundingBox())!;
  expect(slabBox.width).toBeGreaterThan(col.width * 0.9);
  expect(topBox.width).toBeGreaterThan(col.width * 0.75); // never a half column
  expect(topBox.x - slabBox.x).toBeGreaterThanOrEqual(18);
  expect(topBox.y).toBeGreaterThanOrEqual(slabBox.y + 14);
  // bottoms align: the push shrinks the top card, it does not move its end
  expect(Math.abs(topBox.y + topBox.height - (slabBox.y + slabBox.height))).toBeLessThan(3);
});

test("cshape: a lightly-covered container renders one full-width slab under its child", async ({ page }) => {
  await open(page);
  // Wednesday's 'Deep work block' (2h) holds a 30m 'snack break' (25% covered) -> C mode
  const slab = page.getByTestId("cshape-seg").filter({ has: page.locator(".chip-title", { hasText: /^Deep work block$/ }) });
  await expect(slab).toHaveCount(1);
  await expect(page.locator('[title^="Deep work block ("]')).toHaveCount(1); // one shape, no fragments
  const col = (await page.getByTestId("day-col-3").boundingBox())!;
  const slabBox = (await slab.boundingBox())!;
  expect(slabBox.width).toBeGreaterThan(col.width * 0.9);
  expect(slabBox.height).toBeGreaterThanOrEqual(95); // spans the full 2h, not pieces
  // the child paints on top, inset past the visible left strip
  const child = page.locator(".chip-timed", { hasText: "snack break" });
  const childBox = (await child.boundingBox())!;
  expect(childBox.x - slabBox.x).toBeGreaterThanOrEqual(18);
  expect(childBox.width).toBeGreaterThan(col.width * 0.75);
});

test("visual: long slab titles wrap when the uncovered band has room", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const event = (id: string, summary: string, start: string, end: string) => ({
    id, calendar_id: "primary", etag: null, summary, description: null,
    location: null, start, end, all_day: false, timezone: null,
    status: "confirmed", recurrence: null, recurring_event_id: null,
    conference_url: null, updated: null,
  });
  await page.addInitScript((fixture) => { (globalThis as any).__calFixture = fixture; }, {
    calendars: [{ id: "primary", summary: "Personal", color: "#4f8cff", is_primary: true, hidden: false, access_role: "owner" }],
    events: [
      event("long-slab", "Distraction: YouTube anime recaps", "2026-10-14T09:00:00-04:00", "2026-10-14T14:00:00-04:00"),
      event("inside", "Break", "2026-10-14T13:00:00-04:00", "2026-10-14T13:30:00-04:00"),
    ],
  });
  await open(page);
  const slab = page.locator('.chip-cfull[title^="Distraction: YouTube anime recaps"]');
  await expect(slab).toHaveCount(1);
  const title = slab.locator(".chip-title");
  const height = await title.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(45);
  expect(await title.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  await expect(slab).toHaveScreenshot("long-slab-title.png", {
    maxDiffPixelRatio: 0.005,
    threshold: 0.05,
  });
});

test("anatomy: one-hour chips keep their whole title and time at narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 600 });
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  const title = chip.locator(".chip-title");
  // whole title (wrapped if it must), never clamped or cut
  expect(await title.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await title.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(chip.locator(".chip-time")).toBeVisible();
});

test("location: saves from the panel and shows on the chip and in list view", async ({ page }) => {
  await open(page);
  // Swim carries a location: visible on the week chip
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 17 * 48));
  await expect(page.locator(".chip-timed", { hasText: "Swim" }).locator(".chip-loc")).toHaveText(
    "Community pool",
  );
  // edit it in the panel and confirm the chip updates
  await page.locator(".chip-timed", { hasText: "Swim" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByPlaceholder("Location").fill("Golden Gate Park");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".chip-timed", { hasText: "Swim" }).locator(".chip-loc")).toHaveText(
    "Golden Gate Park",
  );
  // list view shows it too
  await page.keyboard.press("l");
  await expect(page.locator(".agenda-row", { hasText: "Swim" }).locator(".agenda-loc")).toHaveText(
    "Golden Gate Park",
  );
});

const PHOTON = {
  features: [
    { properties: { name: "Golden Gate Park", city: "San Francisco", state: "CA", country: "United States" }, geometry: { coordinates: [-122.4821837, 37.7693681] } },
    { properties: { name: "Golden Gate Bridge", city: "San Francisco", state: "CA", country: "United States" }, geometry: { coordinates: [-122.4783, 37.8199] } },
  ],
};
test("location: autocomplete suggests places, picks fill the field, map preview renders", async ({ page }) => {
  await page.route("https://photon.komoot.io/**", (r) => r.fulfill({ json: PHOTON }));
  await page.route("https://www.openstreetmap.org/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<body style='background:#9fb6c9'>map</body>" }),
  );
  await page.goto("/?now=2026-10-14T09:00:00");
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  const panel = page.getByTestId("event-panel");
  const input = panel.getByTestId("loc-input");
  await input.fill("golden ga");
  const pop = panel.getByTestId("loc-pop");
  await expect(pop).toBeVisible();
  await pop.locator(".loc-opt").first().click();
  await expect(input).toHaveValue("Golden Gate Park, San Francisco, CA");
  await expect(panel.getByTestId("loc-preview")).toBeVisible();
  await expect(panel.locator(".loc-preview iframe")).toHaveAttribute("src", /openstreetmap\.org.*marker=37\.76937/);
  await expect(panel.locator(".loc-gmaps")).toHaveAttribute("href", /google\.com\/maps\/search/);
  // keyboard: arrow + enter picks the active suggestion
  await input.fill("golden gate b");
  await expect(pop).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("Golden Gate Bridge, San Francisco, CA");
  // saves through
  await panel.getByRole("button", { name: "Save" }).click();
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  await expect(page.getByTestId("loc-input")).toHaveValue("Golden Gate Bridge, San Francisco, CA");
});

test("selection: clicking empty chrome outside the grid deselects", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click({ modifiers: ["Shift"] });
  await page.locator(".chip-timed", { hasText: "Standup" }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".chip-timed.selected")).toHaveCount(2);
  await page.locator(".sidebar .mini-title").click();
  await expect(page.locator(".chip-timed.selected")).toHaveCount(0);
});

test("draft: a 30-minute draft chip shows a single clean title line", async ({ page }) => {
  await open(page);
  // Sunday evening is free of mock events; scroll there before clicking
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 16 * 48));
  const col = page.getByTestId("day-col-0");
  const b = (await col.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, 400);
  const draft = page.getByTestId("draft-chip");
  await expect(draft).toBeVisible();
  await expect(draft.locator(".chip-title")).toHaveText("(New event)");
  await expect(draft.locator(".chip-time")).toHaveCount(0); // no overlapping second line
});

test("cshape: chips that do not overlap a container keep the full column width", async ({ page }) => {
  await open(page);
  // Swim (Fri 6-8 PM) is hours clear of Sleep (4 AM-1 PM): no spine inset
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 17 * 48));
  const swim = page.locator(".chip-timed", { hasText: "Swim" });
  const col = (await page.getByTestId("day-col-5").boundingBox())!;
  const box = (await swim.boundingBox())!;
  expect(box.x - col.x).toBeLessThan(4);
  expect(box.width).toBeGreaterThan(col.width * 0.9);
  // Workshop (12-1:45 PM) only partially overlaps Sleep: a joint, full width
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 11.5 * 48));
  const workshop = page.locator(".chip-timed", { hasText: "Workshop" });
  expect(((await workshop.boundingBox())!).x - col.x).toBeLessThan(4);
});

test("cshape: full segments are quieter than normal chips of the same calendar", async ({ page }) => {
  await open(page);
  const bgOf = (loc: ReturnType<typeof page.locator>) =>
    loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  const cfull = page.getByTestId("cshape-seg").filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  const plain = page
    .locator(".chip-timed:not(.chip-cfull)")
    .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  expect(await bgOf(cfull)).not.toBe(await bgOf(plain));
});

test("cshape: hover lights the slab without lifting it over its child", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 13.5 * 48));
  const bgOf = (loc: ReturnType<typeof page.locator>) =>
    loc.evaluate((el) => getComputedStyle(el).backgroundColor);
  const slab = page.getByTestId("cshape-seg").filter({ has: page.locator(".chip-title", { hasText: /^Deep work block$/ }) });
  const idle = await bgOf(slab);
  const zOf = (loc: ReturnType<typeof page.locator>) => loc.evaluate((el) => Number(getComputedStyle(el).zIndex));
  const zIdle = await zOf(slab);
  await slab.hover();
  expect(await bgOf(slab)).not.toBe(idle);
  // paint order is the layout's (container under what it encloses): hover
  // never changes it, and every enclosed chip stays above the slab
  expect(await zOf(slab)).toBe(zIdle);
  const kidZ = await slab.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [...el.parentElement!.querySelectorAll<HTMLElement>(".chip-timed:not(.chip-cfull)")]
      .filter((k) => {
        const q = k.getBoundingClientRect();
        return q.top >= r.top - 0.5 && q.bottom <= r.bottom + 0.5 && q.left > r.left;
      })
      .map((k) => Number(getComputedStyle(k).zIndex));
  });
  expect(kidZ.length).toBeGreaterThan(0);
  for (const z of kidZ) expect(z).toBeGreaterThan(zIdle);
});

test("cshape: shift-click selects the container as one shape", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 13.5 * 48));
  await page
    .getByTestId("cshape-seg")
    .filter({ has: page.locator(".chip-title", { hasText: /^Deep work block$/ }) })
    .click({ modifiers: ["Shift"] });
  const sel = page.locator('[title^="Deep work block ("].selected');
  await expect(sel).toHaveCount(1);
  const shadow = await sel.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toContain("10px"); // no per-rectangle elevation pop
});

test("cshape: a container's title sits at its top; a child flush with its start moves below it", async ({ page }) => {
  await open(page);
  // Thursday 'afternoon admin' 2-5 PM starts together with the 1:1 (2-2:30)
  const slab = page.locator('[title^="afternoon admin ("]');
  await expect(slab).toHaveCount(1);
  const title = slab.locator(".chip-title");
  await expect(title).toHaveText("afternoon admin");
  const slabBox = (await slab.boundingBox())!;
  const titleBox = (await title.boundingBox())!;
  expect(titleBox.y - slabBox.y).toBeLessThan(6); // at the top
  const childBox = (await page.locator(".chip-timed", { hasText: "1:1 with manager" }).boundingBox())!;
  expect(childBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1); // below the title
  expect(childBox.y - slabBox.y).toBeLessThan(20); // pushed only one title band
});

test("cshape: contained events start below the container's title band (Study hall)", async ({ page }) => {
  await open(page);
  // Sunday 'Study hall' 10-1 with 'quiz review' flush at 10
  const slab = page.locator('[title^="Study hall ("]');
  const label = slab.locator(".cfull-label");
  await expect(label.locator(".chip-title")).toHaveText("Study hall");
  const slabBox = (await slab.boundingBox())!;
  const labelBox = (await label.boundingBox())!;
  expect(labelBox.y - slabBox.y).toBeLessThan(6);
  const quiz = (await page.locator(".chip-timed", { hasText: "quiz review" }).boundingBox())!;
  expect(quiz.y).toBeGreaterThanOrEqual(labelBox.y + 14);
  // room only fits the title line, so no time line is squeezed in
  await expect(label.locator(".chip-time")).toHaveCount(0);
});

test("cshape: zoomed out, the container title still sits on top with contents below", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+,");
  await page.keyboard.press("ControlOrMeta+Shift+,");
  const slab = page.locator('[title^="Study hall ("]');
  const label = slab.locator(".cfull-label");
  await expect(label.locator(".chip-title")).toHaveText("Study hall");
  const labelBox = (await label.boundingBox())!;
  const quiz = (await page.locator(".chip-timed", { hasText: "quiz review" }).boundingBox())!;
  expect(quiz.y).toBeGreaterThanOrEqual(labelBox.y + 14);
  // tooltip always carries the full range regardless of what text fits
  await expect(slab).toHaveAttribute("title", /Study hall \(10 AM – 1 PM\)/);
});

test("panel: time fields open a 15-min dropdown; end options carry durations (Notion)", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("time-end").focus();
  const pop = panel.getByTestId("time-pop");
  await expect(pop).toBeVisible();
  // options are relative to the 7:00 start and carry durations
  await expect(pop.locator(".time-opt").first()).toContainText("7:15 AM");
  await expect(pop.locator(".time-opt").first()).toContainText("15min");
  await pop.locator(".time-opt").nth(2).click();
  await expect(panel.getByTestId("time-end")).toHaveValue("07:45");
  await expect(pop).toHaveCount(0);
  // picking a start keeps the duration and the list closes on Escape
  await panel.getByTestId("time-start").focus();
  await expect(panel.getByTestId("time-pop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByTestId("time-pop")).toHaveCount(0);
  await expect(panel).toBeVisible(); // Escape closed only the dropdown
});

test("cluster: a cascade of 3+ tiny overlapping events merges into one block of rows", async ({ page }) => {
  await open(page);
  // Thursday 9-10:40 PM: five sub-25-minute chained events
  const block = page.getByTestId("cluster-block").filter({ hasText: "betting odds" });
  await expect(block).toHaveCount(1);
  await expect(block.locator(".cluster-row")).toHaveCount(5);
  await expect(block.locator(".cluster-row").first()).toContainText("Distraction: shopping");
  // the individual sliver chips are gone
  await expect(page.locator(".chip-timed", { hasText: "Browsing furniture" }).locator(".chip-title")).toHaveCount(0);
  // the block spans the full column: no indents, one rectangle
  const col = (await page.getByTestId("day-col-4").boundingBox())!;
  const box = (await block.boundingBox())!;
  expect(box.width).toBeGreaterThan(col.width * 0.9);
  // a row clicks through to its own event
  await block.locator(".cluster-row", { hasText: "betting odds" }).click();
  await expect(page.getByTestId("event-panel").getByPlaceholder("Title")).toHaveValue(
    "betting odds rabbit hole",
  );
  await page.keyboard.press("Escape");
});

test("spotlight: G and the topbar button dim everything except goal work", async ({ page }) => {
  await open(page);
  // star Morning run first so something survives the lens
  await page.locator(".chip-timed", { hasText: "Morning run" }).click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Star as goal work/ }).click();
  await page.getByTestId("spotlight-btn").click();
  const dimmed = page.locator(".chip-timed", { hasText: "Standup" });
  const starred = page.locator(".chip-timed", { hasText: "Morning run" });
  await expect.poll(() => dimmed.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.5);
  await expect.poll(() => starred.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  await page.keyboard.press("g"); // keyboard toggles it back off
  await expect.poll(() => dimmed.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
});

test("recon: cluster rows reconcile via their own hover buttons", async ({ page }) => {
  await open(page);
  // Monday evening cascade ended within the 48h window -> unsettled rows
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 17 * 48));
  const block = page.getByTestId("cluster-block").filter({ hasText: "shopping app" });
  const row = block.locator(".cluster-row", { hasText: "group chat spiral" });
  await expect(row).toHaveClass(/unsettled/);
  await row.hover();
  await row.getByTestId("row-recon-yes").click();
  await expect(row).toHaveClass(/done/);
  // ✕ = didn't happen: the event is deleted (and ⌘Z brings it back)
  const row2 = block.locator(".cluster-row", { hasText: "inbox skim" });
  await row2.hover();
  await row2.getByTestId("row-recon-no").click();
  const anywhere = page.locator(".cluster-row, .chip-timed", { hasText: "inbox skim" });
  await expect(anywhere).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(anywhere).toHaveCount(1);
});

test("recon: the event panel carries reconcile buttons, including happened-at", async ({ page }) => {
  await open(page);
  const run = page.locator(".chip-timed", { hasText: "Morning run" });
  await run.click();
  const panel = page.getByTestId("event-panel");
  const row = panel.getByTestId("panel-recon");
  await expect(row).toContainText("unconfirmed");
  await row.getByTestId("panel-recon-yes").click();
  await expect(run).toHaveClass(/past/);
  await expect(row.getByTestId("panel-recon-yes")).toHaveClass(/active/);
  // toggle off, mark canceled instead: kept on the calendar, struck through
  await row.getByTestId("panel-recon-yes").click();
  await row.getByTestId("panel-recon-canceled").click();
  await expect(run).toHaveClass(/canceled/);
  await expect(row.getByTestId("panel-recon-canceled")).toHaveClass(/active/);
  // happened-at: marks done and focuses the start time for retiming
  await row.getByTestId("panel-recon-move").click();
  await expect(run).toHaveClass(/past/);
  await expect(panel.getByTestId("time-start")).toBeFocused();
  await expect(panel.getByTestId("time-pop")).toBeVisible(); // dropdown ready to retime
  await page.keyboard.press("Escape"); // closes just the dropdown
  await page.keyboard.press("Escape");
  // a future event shows no reconcile row
  await page.locator(".chip-timed", { hasText: "Deep work block" }).click();
  await expect(page.getByTestId("panel-recon")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("recon: hover buttons on an unsettled chip confirm or strike without the keyboard", async ({ page }) => {
  await open(page);
  const run = page.locator(".chip-timed", { hasText: "Morning run" });
  await expect(run).toHaveClass(/unsettled/);
  await run.hover();
  await run.getByTestId("recon-yes").click();
  await expect(run).toHaveClass(/past/);
  // undo path: unconfirm via ctx, then ✕ with the hover button deletes it
  await run.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Unconfirm/ }).click();
  await run.hover();
  await run.getByTestId("recon-no").click();
  await expect(run).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(run).toHaveCount(1);
});

test("drill: the note is editable in place, commits on its own, and survives the form's Save", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 20 * 48));
  const chip = page.locator(".chip-timed", { hasText: "Distraction: TikTok" });
  await chip.click();
  const panel = page.getByTestId("event-panel");
  // click the note to edit it; Enter commits and the panel stays open
  await panel.getByTestId("drill-text").click();
  const input = panel.getByTestId("drill-input");
  await expect(input).toBeFocused();
  await input.fill("Was tired, not lazy. Phone in the other room tomorrow.");
  await input.press("Enter");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("drill-text")).toHaveText("Was tired, not lazy. Phone in the other room tomorrow.");
  await expect(page.getByTestId("margin-note").filter({ hasText: "Was tired" })).toHaveCount(1);
  // Esc cancels the edit, not the panel
  await panel.getByTestId("drill-text").click();
  await panel.getByTestId("drill-input").fill("discard me");
  await panel.getByTestId("drill-input").press("Escape");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("drill-text")).toHaveText(/Was tired/);
  // one line only: a pasted newline becomes a space
  await panel.getByTestId("drill-text").click();
  await panel.getByTestId("drill-input").fill("line one\nline two");
  await expect(panel.getByTestId("drill-input")).toHaveValue("line one line two");
  await panel.getByTestId("drill-input").press("Escape");
  // the event form's Save afterwards keeps the edited note
  await panel.getByPlaceholder("Description").fill("reflection");
  await panel.getByRole("button", { name: "Save" }).click();
  await chip.click();
  await expect(panel.getByTestId("drill-text")).toHaveText(/Was tired/);
  await expect(panel.getByPlaceholder("Description")).toHaveValue("reflection");
  // erase is immediate and undoable
  await panel.getByTestId("drill-erase").click();
  await expect(page.getByTestId("margin-note").filter({ hasText: "Was tired" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("margin-note").filter({ hasText: "Was tired" })).toHaveCount(1);
});

test("drill: an ended event without a note can get one for reflection", async ({ page }) => {
  await open(page);
  const run = page.locator(".chip-timed", { hasText: "Morning run" }); // ended 8 AM
  await run.click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("drill-add").click();
  const input = panel.getByTestId("drill-input");
  await expect(input).toBeFocused();
  await input.fill("Legs felt heavy; earlier bedtime.");
  // clicking away commits too
  await panel.getByPlaceholder("Description").click();
  await expect(panel.getByTestId("drill-text")).toHaveText("Legs felt heavy; earlier bedtime.");
  await expect(page.getByTestId("margin-note").filter({ hasText: "Legs felt heavy" })).toHaveCount(1);
  // a future event offers no note
  await page.keyboard.press("Escape");
  await page.locator(".chip-timed", { hasText: "Standup" }).click();
  await expect(panel.getByTestId("drill-add")).toHaveCount(0);
});

test("drill: a note added and erased in the same open editor is actually removed", async ({ page }) => {
  await open(page);
  const run = page.locator(".chip-timed", { hasText: "Morning run" });
  await run.click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("drill-add").click();
  await panel.getByTestId("drill-input").fill("Temporary reflection.");
  await panel.getByTestId("drill-input").press("Enter");
  await expect(page.getByTestId("margin-note").filter({ hasText: "Temporary reflection" })).toHaveCount(1);

  await panel.getByTestId("drill-erase").click();
  await expect(panel.getByTestId("panel-drill")).toHaveCount(0);
  await expect(page.getByTestId("margin-note").filter({ hasText: "Temporary reflection" })).toHaveCount(0);
  await expect(run).toHaveCount(1);
});

test("notes: a note is written in the margin and splits in the editor", async ({ page }) => {
  await open(page);
  // Monday 9 PM 'Distraction: TikTok' carries a [DRILL] line in its description
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 20 * 48));
  const chip = page.locator(".chip-timed", { hasText: "Distraction: TikTok" });
  await expect(page.getByTestId("margin-note").filter({ hasText: "Forty minutes of scrolling" })).toHaveCount(1);
  // the editor shows it as the red-pen block, NOT inside the description box
  await chip.click();
  const panel = page.getByTestId("event-panel");
  await expect(panel.getByTestId("panel-drill")).toContainText("Forty minutes of scrolling");
  await expect(panel.getByPlaceholder("Description")).toHaveValue("");
  // editing + saving preserves the annotation in the stored description
  await panel.getByPlaceholder("Description").fill("note to self");
  await panel.getByRole("button", { name: "Save" }).click();
  await chip.click();
  await expect(panel.getByTestId("panel-drill")).toContainText("Forty minutes of scrolling");
  await expect(panel.getByPlaceholder("Description")).toHaveValue("note to self");
  // erasing the note removes it at once (no Save needed)
  await panel.getByTestId("drill-erase").click();
  await expect(panel.getByTestId("panel-drill")).toHaveCount(0);
  await expect(page.getByTestId("margin-note").filter({ hasText: "Forty minutes of scrolling" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("recon: past events stay unsettled until confirmed; score credits confirmed only", async ({ page }) => {
  await open(page);
  // Morning run (7-8 AM today) has ended but nobody confirmed it
  const run = page.locator(".chip-timed", { hasText: "Morning run" });
  await expect(run).toHaveClass(/unsettled/);
  // ended, so it reads as past (faded) like any other; the dotted outline marks it unconfirmed
  await expect(run).toHaveClass(/past/);
  // today's score badge shows unconfirmed time as unaccounted (badge absent: nothing confirmed yet)
  const todayScore = page.locator(".day-head.today").getByTestId("day-score");
  await expect(todayScore).toHaveCount(0);
  // confirm via context menu -> settles into the past and the score credits it
  await run.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Happened/ }).click();
  await expect(run).toHaveClass(/past/);
  await expect(run).not.toHaveClass(/unsettled/);
  await expect(todayScore).toBeVisible();
  // strike a different past event: Standup hasn't ended at 9AM... use morning walk (Tue is grandfathered) -> use ctx on run again to unconfirm
  await run.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Unconfirm/ }).click();
  await expect(run).toHaveClass(/unsettled/);
});

test("recon: R triage mode walks the queue with Y/X and the sweep banner bulk-confirms", async ({ page }) => {
  // raw open: this test is ABOUT the sweep banner the helper dismisses
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  // yesterday (Tue) is inside the 48h window -> sweep banner appears
  const banner = page.getByTestId("sweep-banner");
  await expect(banner).toBeVisible();
  // R-mode first: triage today's Morning run
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("Reconcile:");
  await page.keyboard.press("y"); // happened -> advances or exits
  // mark everything else via keyboard until the pill closes (queue is small)
  for (let i = 0; i < 48 && (await pill.count()) > 0; i++) await page.keyboard.press("y");
  await expect(pill).toHaveCount(0);
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveClass(/past/);
  // reload: banner still offers yesterday? everything confirmed -> no banner
  await page.reload();
  await expect(page.locator(".mock-badge")).toBeVisible();
  await expect(page.getByTestId("sweep-banner")).toHaveCount(0);
});

test("recon: 'canceled' strikes through and stays on the calendar", async ({ page }) => {
  await open(page);
  const run = page.locator(".chip-timed", { hasText: "Morning run" });
  await run.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /^Canceled/ }).click();
  await expect(run).toHaveClass(/canceled/);
  // still present (a record, not a delete) with struck title
  const deco = await run
    .locator(".chip-title")
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(deco).toContain("line-through");
});

test("recon: 'didn't happen' deletes the event, from the menu and the panel; ⌘Z restores it", async ({ page }) => {
  await open(page);
  const run = page.locator(".chip-timed", { hasText: "Morning run" });
  await run.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Didn't happen/ }).click();
  await expect(run).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(run).toHaveCount(1);
  // the panel's ✕ Didn't: deletes and closes the panel
  await run.click();
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("panel-recon-no").click();
  await expect(run).toHaveCount(0);
  await expect(panel).toHaveCount(0);
});

test("recon: triage X deletes, C cancels (kept, struck)", async ({ page }) => {
  await open(page);
  await page.keyboard.press("r");
  const pill = page.getByTestId("recon-pill");
  await expect(pill).toBeVisible();
  const first = (await pill.locator("b").textContent())!;
  await page.keyboard.press("c");
  await expect(page.locator(".chip-timed, .cluster-row", { hasText: first }).first()).toHaveClass(/canceled/);
  const second = (await pill.locator("b").textContent())!;
  // titles repeat across days (LUNCH...): one fewer event with that title
  const same = page.locator(".chip-timed, .cluster-row").filter({ hasText: new RegExp(`^\\W*${second}`) });
  const before = await same.count();
  await page.keyboard.press("x");
  await expect(same).toHaveCount(before - 1);
});

test("cluster: rows drag out of the block and retime like normal chips", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 19.5 * 48));
  const block = page.getByTestId("cluster-block").filter({ hasText: "Browsing furniture" });
  await expect(block.locator(".cluster-row")).toHaveCount(5);
  const row = block.locator(".cluster-row", { hasText: "betting odds" });
  const rb = (await row.boundingBox())!;
  // drag the row ~3 hours down into empty Thursday evening
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2 - 4 * 48, { steps: 6 });
  await page.mouse.up();
  // it left the cluster and lives as a plain chip at the new time; without
  // it the remaining tangle re-components into 3 clustered + 1 free chip
  await expect(block.locator(".cluster-row")).toHaveCount(3);
  const chip = page.locator(".chip-timed", { hasText: "betting odds" });
  await expect(chip).toBeVisible();
  // undo returns it to the block
  await page.keyboard.press("ControlOrMeta+z");
  await expect(block.locator(".cluster-row")).toHaveCount(5);
  // a plain click on a row still opens the editor
  await block.locator(".cluster-row", { hasText: "betting odds" }).click();
  await expect(page.getByTestId("event-panel").getByPlaceholder("Title")).toHaveValue(
    "betting odds rabbit hole",
  );
  await page.keyboard.press("Escape");
});

test("scores: past and today day headers carry a focus score, future days none", async ({ page }) => {
  await open(page);
  const heads = page.locator(".day-head");
  // Monday is fully scored; Friday is future; today scores the day so far
  await expect(heads.nth(1).getByTestId("day-score")).toBeVisible();
  await expect(heads.nth(5).getByTestId("day-score")).toHaveCount(0);
  // today has only unconfirmed time at 9 AM -> no badge until reconciled
  // (the recon suite covers confirming and the badge appearing)
  await expect(page.locator(".day-head.today").getByTestId("day-score")).toHaveCount(0);
  const v = Number(await heads.nth(1).getByTestId("day-score").textContent());
  expect(v).toBeGreaterThanOrEqual(0);
  expect(v).toBeLessThanOrEqual(100);
  // hovering the badge explains it: the biggest loss, the three factors, the formula
  await heads.nth(1).getByTestId("day-score").hover();
  const pop = page.getByTestId("score-pop");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText(`Focus ${v}`);
  await expect(pop.getByTestId("score-reason")).not.toBeEmpty();
  for (const part of ["deep", "restraint", "sleep"]) await expect(pop.getByTestId(`score-part-${part}`)).toBeVisible();
  await expect(pop).toContainText("100 × deep");
  await expect(pop).toContainText("Homework, Learning and Research, Enrichment");
  await page.mouse.move(5, page.viewportSize()!.height - 5);
  // Sunday: the interrupted Study hall (Learning and Research) is the only deep work
  await heads.nth(0).getByTestId("day-score").hover();
  await expect(pop.getByTestId("score-reason")).toHaveText("2 interruptions cut 3h of deep work to 1h05");
  // shown whole, not clipped by the header strip
  const pb = (await pop.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(pb.height).toBeGreaterThan(100);
  expect(pb.x).toBeGreaterThanOrEqual(0);
  expect(pb.x + pb.width).toBeLessThanOrEqual(vp.width);
  await page.mouse.move(5, vp.height - 5);
  await expect(pop).toHaveCount(0);
});

test("stars: classifier suggestions show hollow and confirm/suppress correctly", async ({ page }) => {
  await open(page);
  // the mock classifier tags 'Read style guide' as goal work -> hollow star
  const chip = page.locator(".chip-timed", { hasText: "Read style guide" });
  await expect(chip).toHaveClass(/starred-auto/);
  // a suggestion: the gold shine (a touch softer), bold title, no glyph
  await expect(chip.getByTestId("goal-ring")).toHaveClass(/auto/);
  await expect(chip.getByTestId("goal-shine")).toHaveCount(1);
  await expect(chip.locator(".chip-star")).toHaveCount(0);
  // the sidebar counts the suggestion on its goal
  await chip.click();
  const sel = page.getByTestId("goal-link");
  await expect(sel).toHaveValue("__auto");
  // confirming: pick a real goal -> solid star
  await sel.selectOption("3 gym sessions");
  await page.keyboard.press("Escape");
  await expect(chip).toHaveClass(/\bstarred\b/);
  // confirmed: the ring shines and the title turns bold
  await expect(chip.getByTestId("goal-ring")).toHaveClass(/manual/);
  expect(await chip.locator(".chip-title").first().evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600");
  // suppressing: 'Not goal work' sticks even though the suggestion remains
  await chip.click();
  await page.getByTestId("goal-link").selectOption("");
  await page.keyboard.press("Escape");
  await expect(chip).not.toHaveClass(/starred/);
  await page.reload();
  await expect(page.locator(".chip-timed", { hasText: "Read style guide" })).not.toHaveClass(/starred/);
});

test("stars: context-menu star marks the chip and links to a goal from the panel", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Morning run" });
  await chip.click({ button: "right" });
  await page.getByTestId("ctx-menu").getByRole("button", { name: /Star as goal work/ }).click();
  await expect(chip).toHaveClass(/starred/);
  await expect(chip.getByTestId("goal-ring")).toHaveClass(/manual/);
  await expect(chip.getByTestId("goal-shine")).toHaveCount(1);
  // link it to a specific goal in the panel
  await chip.click();
  const sel = page.getByTestId("goal-link");
  await expect(sel).toHaveValue("__starred");
  await sel.selectOption("3 gym sessions");
  await page.keyboard.press("Escape");
  // the goal row in the sidebar now counts it
  const row = page.getByTestId("goal-row").filter({ hasText: "3 gym sessions" });
  await expect(row.locator(".goal-star-count")).toHaveText("★ 1");
  // unstar via the panel clears everything
  await chip.click();
  await page.getByTestId("goal-link").selectOption("");
  await page.keyboard.press("Escape");
  await expect(chip).not.toHaveClass(/starred/);
  await expect(row.locator(".goal-star-count")).toHaveCount(0);
});

test("topbar: one Notion-style dropdown drives every view including # of days", async ({ page }) => {
  await open(page);
  const btn = page.getByTestId("view-menu-btn");
  await expect(btn).toContainText("Week");
  await btn.click();
  const menu = page.getByTestId("view-menu");
  await expect(menu.getByRole("menuitem", { name: /Insights/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Month/ }).click();
  await expect(page.getByTestId("month-grid")).toBeVisible();
  await expect(btn).toContainText("Month");
  // number of days lives in the same menu
  await btn.click();
  await page.getByTestId("view-menu-days").click();
  await menu.getByRole("menuitem", { name: /^3 days/ }).click();
  await expect(btn).toContainText("3 days");
  await expect(page.getByTestId("week-grid")).toBeVisible();
  await expect(page.locator("[data-testid^=day-col-]")).toHaveCount(3);
  // insights reachable from the menu
  await btn.click();
  await menu.getByRole("menuitem", { name: /Insights/ }).click();
  await expect(page.getByTestId("insights-view")).toBeVisible();
});

test("gesture: horizontal scroll slides the window day by day, proportional to the swipe", async ({ page }) => {
  await open(page);
  const firstHead = page.locator(".day-head").first();
  await expect(firstHead).toContainText("11"); // week starts Sun Oct 11
  const grid = page.getByTestId("week-grid");
  const box = (await grid.boundingBox())!;
  const colW = (box.width - 46) / 7;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  // Whole-column swipes advance by a day; fractional pixels carry forward.
  await page.mouse.wheel(Math.ceil(colW), 0);
  await expect(firstHead).toContainText("12"); // one column = one day
  await page.mouse.wheel(Math.ceil(colW * 5) + 2, 0);
  await expect(firstHead).toContainText("17"); // long swipe carries five
  await page.mouse.wheel(-(Math.ceil(colW * 3) + 20), 0);
  await expect(firstHead).toContainText("14"); // back three
  // Explicit navigation returns to the current week.
  await page.keyboard.press("t");
  await expect(firstHead).toContainText("11");
});

test("gesture: narrow week headers stay aligned with their day columns while panning", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page);
  const header = page.locator(".day-headers .day-head").first();
  const body = page.getByTestId("day-col-0");
  const clip = page.locator(".day-headers .pan-clip");
  const checkAlignment = async () => {
    const h = (await header.boundingBox())!;
    const b = (await body.boundingBox())!;
    const c = (await clip.boundingBox())!;
    expect(Math.abs(h.x - b.x)).toBeLessThan(1);
    expect(Math.abs(h.width - b.width)).toBeLessThan(1);
    expect(await clip.evaluate((el) => getComputedStyle(el).overflowX)).toBe("hidden");
    for (const day of await page.locator(".day-headers .day-head").all()) {
      const cell = (await day.boundingBox())!;
      for (const label of await day.locator(".dow, .dnum, .score-wrap").all()) {
        const content = (await label.boundingBox())!;
        expect(content.x).toBeGreaterThanOrEqual(cell.x);
        expect(content.x + content.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
      }
    }
  };
  await checkAlignment();
  await page.getByTestId("week-grid").dispatchEvent("wheel", { deltaX: 90, deltaY: 0 });
  await page.waitForTimeout(300);
  await checkAlignment();
});

test("gesture: nine-day pan keeps every four-pixel step across day boundaries", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page);
  await page.keyboard.press("9");
  await expect(page.locator(".day-headers .day-head")).toHaveCount(9);
  const positions = await page.evaluate(async () => {
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const strip = document.querySelector<HTMLElement>(".day-headers .pan-strip")!;
    const firstDay = () => Number(document.querySelector(".day-head .dnum")!.textContent);
    const dayWidth = document.querySelector(".day-head")!.getBoundingClientRect().width;
    const startDay = firstDay();
    const result: number[] = [];
    for (let i = 0; i < 40; i++) {
      grid.dispatchEvent(new WheelEvent("wheel", { deltaX: 4, deltaY: 0, bubbles: true, cancelable: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const m = strip.style.transform.match(/([+-]) ([\d.]+)px/);
      const residual = m ? Number(m[2]) * (m[1] === "-" ? 1 : -1) : 0;
      result.push((firstDay() - startDay) * dayWidth + residual);
    }
    return result;
  });
  expect(Math.max(...positions.map((position, i) => Math.abs(position - 4 * (i + 1))))).toBeLessThan(1);
});

test("sidebar: calendars split into My calendars and Other calendars (Google)", async ({ page }) => {
  await open(page);
  const mine = page.getByTestId("cal-group-my");
  const other = page.getByTestId("cal-group-other");
  await expect(mine.locator(".cal-row", { hasText: "Personal" })).toBeVisible();
  await expect(mine.locator(".cal-row", { hasText: "Work" })).toBeVisible();
  await expect(other.locator(".cal-row", { hasText: "US Holidays" })).toBeVisible();
  await expect(mine.locator(".cal-row", { hasText: "US Holidays" })).toHaveCount(0);
  // primary sorts first in My calendars
  await expect(mine.locator(".cal-row").first()).toContainText("Personal");
  // collapsing persists across reload and shows a count
  await other.locator(".cal-group-head").click();
  await expect(other.locator(".cal-row")).toHaveCount(0);
  await expect(other.locator(".cal-group-count")).toHaveText("1");
  await page.reload();
  await expect(page.getByTestId("cal-group-other").locator(".cal-row")).toHaveCount(0);
  await page.getByTestId("cal-group-other").locator(".cal-group-head").click();
  await expect(
    page.getByTestId("cal-group-other").locator(".cal-row", { hasText: "US Holidays" }),
  ).toBeVisible();
});

test("allday: clicking the empty all-day lane drafts an all-day event (Notion)", async ({ page }) => {
  await open(page);
  const cell = page.getByTestId("allday-row").locator(".allday-cell").first(); // empty Sunday
  await cell.click({ position: { x: 40, y: 8 } });
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".all-day-label")).toContainText("All day");
  await page.keyboard.press("Escape");
});

test("allday: dragging across the lane drafts a multi-day event and saves the span", async ({ page }) => {
  await open(page);
  const row = page.getByTestId("allday-row");
  const sun = (await row.locator(".allday-cell").nth(0).boundingBox())!;
  const tue = (await row.locator(".allday-cell").nth(2).boundingBox())!;
  await page.mouse.move(sun.x + 30, sun.y + 8);
  await page.mouse.down();
  await page.mouse.move(tue.x + 30, tue.y + 8, { steps: 4 });
  await page.mouse.up();
  const panel = page.getByTestId("event-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("allday-end")).toHaveValue("2026-10-13"); // Sun..Tue inclusive
  await panel.getByPlaceholder("Title").fill("conference");
  await panel.getByRole("button", { name: "Create" }).click();
  // the bar spans three day cells
  await expect(row.locator(".chip-allday", { hasText: "conference" })).toHaveCount(3);
});

test("ctx menu: Cut and Copy rows feed the paste clipboard (Notion menu parity)", async ({ page }) => {
  await open(page);
  await page.locator(".chip-timed", { hasText: "Morning run" }).click({ button: "right" });
  const menu = page.getByTestId("ctx-menu");
  await expect(menu.getByRole("button", { name: /^Copy/ })).toBeVisible();
  await menu.getByRole("button", { name: /^Cut/ }).click();
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+v"); // paste on anchor (today = same day)
  await expect(page.locator(".chip-timed", { hasText: "Morning run" })).toHaveCount(1);
});

test("anatomy: short chips show title + inline start time on one line (Notion)", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+,"); // 36px/h: LUNCH (45m) is short
  const lunch = page.locator(".chip-timed", { hasText: "LUNCH" }).first();
  await expect(lunch.locator(".chip-time-inline")).toHaveText("1:30 PM");
  await expect(lunch.locator(".chip-time")).toHaveCount(0); // no second line
});

test("anatomy: tall chips wrap long titles over multiple lines (Notion)", async ({ page }) => {
  await open(page);
  const chip = page.locator(".chip-timed", { hasText: "Distraction: YouTube and Twitch" });
  const title = chip.locator(".chip-title");
  const h = (await title.boundingBox())!.height;
  expect(h).toBeGreaterThan(24); // two 15px lines, not a single ellipsized one
});

test("parity: week navigation preserves the scroll position (Notion)", async ({ page }) => {
  await open(page);
  const grid = page.getByTestId("week-grid");
  await grid.evaluate((el) => (el.scrollTop = 300));
  await page.keyboard.press("j");
  await expect.poll(async () => Math.abs((await grid.evaluate((el) => el.scrollTop)) - 300)).toBeLessThan(3);
  await page.keyboard.press("t");
  await expect.poll(async () => Math.abs((await grid.evaluate((el) => el.scrollTop)) - 300)).toBeLessThan(3);
});

test("cshape: barely-overlapping chains stay one continuous full-width column", async ({ page }) => {
  await open(page);
  // Saturday evening: errand run / grocery pickup / meal prep each bleed 15
  // minutes into the next - no nesting, no indents, no columns
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 16.5 * 48));
  const col = (await page.getByTestId("day-col-6").boundingBox())!;
  for (const name of ["errand run", "grocery pickup", "meal prep"]) {
    const chip = page.locator(".chip-timed", { hasText: name });
    const box = (await chip.boundingBox())!;
    expect(box.x - col.x, name + " starts at the column edge").toBeLessThan(4);
    expect(box.width, name + " spans the full column").toBeGreaterThan(col.width * 0.9);
    await expect(chip.locator(".chip-title")).toHaveText(name); // title visible
  }
  // none of them became a background slab
  for (const name of ["errand run", "grocery pickup", "meal prep"]) {
    await expect(page.locator('[data-testid="cshape-seg"][title^="' + name + '"]')).toHaveCount(0);
  }
  // the later chip paints over the earlier tail (DOM order)
  const g = page.locator(".chip-timed", { hasText: "grocery pickup" });
  const e = page.locator(".chip-timed", { hasText: "errand run" });
  const gi = await g.evaluate((el) => Array.prototype.indexOf.call(el.parentNode!.children, el));
  const ei = await e.evaluate((el) => Array.prototype.indexOf.call(el.parentNode!.children, el));
  expect(gi).toBeGreaterThan(ei);
});

// --- overlap LAWS (user, 2026-10-15): checked generically over every day ---

async function lawProbe(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1500 });
  // scroll through the day in chunks so tall zooms are fully covered; only
  // judge points inside the visible grid body (not under sticky headers)
  return page.evaluate(async () => {
    const blanks = new Set<string>();
    const hidden = new Map<string, true | string>(); // key -> visible, or why not
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const body = grid.querySelector<HTMLElement>(".grid-body")!;
    const step = Math.max(200, grid.clientHeight - 200);
    for (let st = 0; ; st += step) {
      grid.scrollTop = st;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const gr = grid.getBoundingClientRect();
      const visTop = Math.max(gr.top, body.getBoundingClientRect().top - (body.getBoundingClientRect().top - gr.top) + (body.offsetTop - grid.scrollTop > 0 ? body.offsetTop - grid.scrollTop : 0));
      const headerBottom = (grid.querySelector(".allday-row") as HTMLElement | null)?.getBoundingClientRect().bottom ?? gr.top;
      const lo = Math.max(visTop, headerBottom) + 2;
      const hi = gr.bottom - 2;
      for (const col of grid.querySelectorAll<HTMLElement>("[data-testid^=day-col-]")) {
        const cr = col.getBoundingClientRect();
        const boxes = [...col.querySelectorAll<HTMLElement>(".chip-timed, .cluster-block")].map((el) => {
          const r = el.getBoundingClientRect();
          return { el, top: r.top, bottom: r.bottom };
        });
        boxes.sort((a, b) => a.top - b.top);
        const comps: { top: number; bottom: number; n: number }[] = [];
        for (const b of boxes) {
          const last = comps[comps.length - 1];
          if (last && b.top < last.bottom - 0.5) {
            last.bottom = Math.max(last.bottom, b.bottom);
            last.n++;
          } else comps.push({ top: b.top, bottom: b.bottom, n: 1 });
        }
        // LAW 1: inside any overlap component, no blank horizontal space
        for (const c of comps) {
          if (c.n < 2) continue;
          for (let y = c.top + 6; y < c.bottom - 6; y += 3) {
            if (y < lo || y > hi) continue;
            for (const fx of [6, cr.width / 2, cr.width - 7]) {
              // looking through the margin notes: they may sit on bodies
              const hit = document
                .elementsFromPoint(cr.left + fx, y)
                .find((h) => !h.closest("[data-testid=margin-notes]")) as HTMLElement | undefined;
              if (!hit || !hit.closest(".chip-timed, .cluster-block")) {
                blanks.add(`${col.dataset.testid} t=${Math.round(y - cr.top)}px x=${Math.round(fx)}`);
              }
            }
          }
        }
        // LAW 2: every chip's title start is visible (judged when on screen)
        for (const { el } of boxes) {
          const title = el.querySelector<HTMLElement>(".chip-title");
          if (!title) continue;
          const tr = title.getBoundingClientRect();
          if (tr.width === 0) continue;
          const y = tr.top + Math.min(7, tr.height / 2);
          if (y < lo || y > hi) continue;
          const key = `${col.dataset.testid}: ${title.textContent}`;
          const hit = document.elementFromPoint(tr.left + 4, y) as HTMLElement | null;
          const owner = hit?.closest(".chip-timed, .cluster-block") as HTMLElement | null;
          const ok = owner === el;
          if (!hidden.has(key) || ok) {
            const by = owner
              ? `${(owner.title || owner.textContent || "").slice(0, 40)} (${owner.className.replace("chip chip-timed", "").trim().slice(0, 24)})`
              : `nothing: ${hit?.className ?? "off-screen"}`;
            hidden.set(key, ok ? true : `${Math.round(tr.top - cr.top)}px, covered by ${by}`);
          }
        }
      }
      if (st + grid.clientHeight >= grid.scrollHeight) break;
    }
    grid.scrollTop = 0;
    return {
      blanks: [...blanks],
      hidden: [...hidden.entries()].filter(([, v]) => v !== true).map(([k, v]) => `${k} @ ${v}`),
    };
  });
}

test("LAW: no blank space inside any overlap, every title visible (week)", async ({ page }) => {
  await open(page);
  const { blanks, hidden } = await lawProbe(page);
  expect(blanks, "blank space inside overlapping events").toEqual([]);
  expect(hidden, "titles covered by other events").toEqual([]);
});

test("LAW: same laws hold zoomed out and zoomed in", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+Shift+,"); // 36px/h
  let r = await lawProbe(page);
  expect(r.blanks).toEqual([]);
  expect(r.hidden).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+.");
  await page.keyboard.press("ControlOrMeta+Shift+.");
  await page.keyboard.press("ControlOrMeta+Shift+."); // 84px/h
  r = await lawProbe(page);
  expect(r.blanks).toEqual([]);
  expect(r.hidden).toEqual([]);
});

test("joints: partial overlaps (chip↔chip and chip↔slab) meet in a rounded step", async ({ page }) => {
  await open(page);
  // Sat 3:18 'Distraction: late scrolling' tail-overlaps Saturday's Sleep
  const a = page.locator(".chip-timed", { hasText: "Distraction: late scrolling" });
  const clip = await a.evaluate((el) => getComputedStyle(el).clipPath);
  expect(clip).toContain("path(");
  expect(clip).toContain("Q"); // corners are rounded, not hard 90° notches
  // Workshop tail-overlaps Friday's Sleep slab: a joint, NOT a nested inset chip
  const workshop = page.locator(".chip-timed", { hasText: "Workshop" });
  const col = (await page.getByTestId("day-col-5").boundingBox())!;
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 11 * 48));
  expect(((await workshop.boundingBox())!).x - col.x).toBeLessThan(4);
  const slabClip = await page
    .locator('[data-testid="cshape-seg"][title^="Sleep ("]')
    .first()
    .evaluate((el) => getComputedStyle(el).clipPath);
  expect(slabClip).toContain("path(");
});

test("cshape: long events without overlaps stay plain full-width chips", async ({ page }) => {
  await open(page);
  // Saturday's Sleep contains nothing -> regular chip, not a container
  // (match the exact title; 'Asleep …' events would match a substring filter)
  const satSleep = page
    .locator(".chip-timed:not(.chip-cfull)")
    .filter({ has: page.locator(".chip-title", { hasText: /^Sleep$/ }) });
  await expect(satSleep).toHaveCount(1);
  const box = (await satSleep.boundingBox())!;
  const col = (await page.getByTestId("day-col-6").boundingBox())!;
  expect(box.width).toBeGreaterThan(col.width * 0.8);
});

test("cshape: a fully-covered slab is still clickable via its title band", async ({ page }) => {
  await open(page);
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 9 * 48));
  const slab = page.locator('[title^="Admin block ("]');
  await slab.click({ position: { x: 60, y: 8 } }); // the title band above the children
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await expect(page.getByTestId("event-panel").getByPlaceholder("Title")).toHaveValue("Admin block");
  await page.keyboard.press("Escape");
  // an open slab region opens its event too
  await page.getByTestId("week-grid").evaluate((el) => (el.scrollTop = 14 * 48));
  await page.getByTestId("cshape-seg").filter({ has: page.locator(".chip-title", { hasText: /^Deep work block$/ }) }).click();
  await expect(page.getByTestId("event-panel")).toBeVisible();
  await page.keyboard.press("Escape");
});

// --- Obsidian bridge (weekly review / journal) ---

test("obsidian: weekly review renders the journal and appends entries", async ({ page }) => {
  await open(page);
  await page.getByTestId("goals-section").getByRole("button", { name: "Weekly review" }).click();
  const review = page.getByTestId("review-view");
  await expect(review).toBeVisible();
  await expect(review.locator("h2.review-h").first()).toContainText("Weekly Review — Oct 5");
  await review.getByTestId("review-entry").fill("Shipped the calendar QA sprint. Sleep was stable.");
  await review.getByRole("button", { name: "Add entry" }).click();
  await expect(review.locator("h2.review-h").last()).toContainText("Weekly Review — Oct 14, 2026");
  await expect(review.locator(".review-p", { hasText: "Shipped the calendar QA sprint" })).toBeVisible();
});

test("obsidian: journal task toggles write back through the review view", async ({ page }) => {
  await open(page);
  await page.getByTestId("goals-section").getByRole("button", { name: "Weekly review" }).click();
  const review = page.getByTestId("review-view");
  const task = review.locator(".review-task", { hasText: "Planned next week" });
  await task.locator("input").check();
  await expect(task.locator("span.done")).toBeVisible();
});

// --- insights (all 10, dense one-liners) ---

test("insights: renders all ten stat rows with real numbers", async ({ page }) => {
  await open(page);
  await page.keyboard.press("i");
  const v = page.getByTestId("insights-view");
  await expect(v).toBeVisible();
  for (const id of [
    "ins-sleep",
    "ins-distraction",
    "ins-deepwork",
    "ins-score",
    "ins-alloc",
    "ins-goals",
    "ins-routines",
    "ins-fragmentation",
    "ins-forecast",
    "ins-report",
  ]) {
    await expect(v.getByTestId(id)).toBeVisible();
  }
  await expect(v.getByTestId("ins-sleep").locator(".ins-big")).toContainText("h");
  await expect(v.getByTestId("ins-distraction")).toContainText("top: YouTube");
  await expect(v.getByTestId("ins-goals").locator(".ins-big")).toHaveText("2/6");
  await expect(v.getByTestId("ins-routines")).toContainText("LUNCH 2/2");
});

test("insights: week report appends into the Obsidian journal", async ({ page }) => {
  await open(page);
  await page.keyboard.press("i");
  await page.getByTestId("ins-report").getByRole("button", { name: "Append to journal" }).click();
  await expect(page.getByTestId("toast")).toContainText("appended");
  // verify it landed in the journal view
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".cmdk [cmdk-input]").fill("weekly review");
  await page.locator(".cmdk").getByText("📓 Weekly review").click();
  await expect(page.getByTestId("review-view").locator("h2.review-h").last()).toContainText(
    "Oct 14, 2026",
  );
  await expect(page.getByTestId("review-view")).toContainText("Deep work");
});
