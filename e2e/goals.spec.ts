// Goals (lib/goals.ts + the sidebar's Goals section): daily, weekly and
// long-term goals kept by the app, laid out like the calendar lists.
import { expect, test, type Page } from "@playwright/test";
import { isDone, periodOf, type GoalsFile } from "../src/lib/goals";

const NOW = "2026-10-14T09:00:00";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent(NOW)}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}

test("goals: daily, weekly and long-term groups in the calendar lists' style, with tallies", async ({ page }) => {
  await open(page);
  const goals = page.getByTestId("goals-section");
  for (const [key, label, tally] of [
    ["daily", "Daily", "1/3"],
    ["weekly", "Weekly", "1/3"],
    ["long", "Long-term", "0/3"],
  ]) {
    const head = goals.getByTestId(`goal-group-${key}`).locator(".cal-group-head");
    await expect(head).toContainText(label);
    await expect(head.locator(".cal-group-count")).toHaveText(tally);
  }
  // same anatomy as a calendar row: the row font, the tick where a dot sits
  const row = goals.getByTestId("goal-row").first();
  const calRow = page.locator(".cal-row").first();
  const font = (l: typeof row) => l.evaluate((el) => getComputedStyle(el).fontSize);
  expect(await font(row)).toBe(await font(calRow));
  // no card around the section any more
  expect(await goals.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
});

test("goals: tick, add, rename and delete; collapsed groups are remembered", async ({ page }) => {
  await open(page);
  const goals = page.getByTestId("goals-section");
  const daily = goals.getByTestId("goal-group-daily");
  const deep = daily.getByTestId("goal-row").filter({ hasText: "2h deep work" });
  await deep.getByRole("checkbox").click();
  await expect(deep).toHaveClass(/done/);
  await expect(daily.locator(".cal-group-count")).toHaveText("2/3");
  await deep.getByRole("checkbox").click();
  await expect(daily.locator(".cal-group-count")).toHaveText("1/3");

  // add a weekly goal from the section's ＋
  await goals.getByTestId("goal-add").click();
  const form = goals.getByTestId("goal-add-form");
  await form.getByRole("radio", { name: "Weekly" }).click();
  await form.locator("input").fill("Call home twice");
  await form.locator("input").press("Enter");
  const weekly = goals.getByTestId("goal-group-weekly");
  await expect(weekly.getByTestId("goal-row").filter({ hasText: "Call home twice" })).toHaveCount(1);
  await expect(weekly.locator(".cal-group-count")).toHaveText("1/4");

  // rename by double-click; emptying it deletes it
  const added = weekly.getByTestId("goal-row").filter({ hasText: "Call home twice" });
  await added.locator(".goal-text").dblclick();
  // (while editing, the text lives in the input)
  await weekly.locator(".goal-edit").fill("Call home three times");
  await weekly.locator(".goal-edit").press("Enter");
  await expect(weekly.getByTestId("goal-row").filter({ hasText: "Call home three times" })).toHaveCount(1);
  await weekly.getByTestId("goal-row").filter({ hasText: "Call home three times" }).locator(".goal-text").dblclick();
  await weekly.locator(".goal-edit").fill("");
  await weekly.locator(".goal-edit").press("Enter");
  await expect(weekly.getByTestId("goal-row")).toHaveCount(3);

  // delete from the row
  const lt = goals.getByTestId("goal-group-long");
  await lt.getByTestId("goal-row").filter({ hasText: "Learn Spanish" }).hover();
  await lt.getByTestId("goal-row").filter({ hasText: "Learn Spanish" }).getByRole("button", { name: "Delete goal" }).click();
  await expect(lt.getByTestId("goal-row")).toHaveCount(2);

  // collapse is remembered
  await lt.locator(".cal-group-head").click();
  await expect(lt.getByTestId("goal-row")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("goal-group-long").getByTestId("goal-row")).toHaveCount(0);
});

test("goals: a daily tick lasts the day, a weekly tick the week, a long-term tick for good", () => {
  const f: GoalsFile = {
    goals: [
      { id: "d", text: "daily", horizon: "daily" },
      { id: "w", text: "weekly", horizon: "weekly" },
      { id: "l", text: "long", horizon: "long" },
    ],
    checks: {},
  };
  const wed = new Date(2026, 9, 14, 9);
  for (const g of f.goals) f.checks[g.id] = periodOf(g.horizon, wed);
  const [d, w, l] = f.goals;
  expect([isDone(f, d, wed), isDone(f, w, wed), isDone(f, l, wed)]).toEqual([true, true, true]);
  const thu = new Date(2026, 9, 15, 9);
  expect([isDone(f, d, thu), isDone(f, w, thu), isDone(f, l, thu)]).toEqual([false, true, true]);
  const nextMon = new Date(2026, 9, 19, 9);
  expect([isDone(f, d, nextMon), isDone(f, w, nextMon), isDone(f, l, nextMon)]).toEqual([false, false, true]);
});
