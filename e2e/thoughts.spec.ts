// The sidebar's Goals fold away as a whole, and under them the thought dump
// keeps bullet points of things to think about (components/Sidebar.tsx
// ThoughtsSection, stored with the goals: lib/goals.ts, goals.json).
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto(`/?now=${encodeURIComponent("2026-10-14T09:00:00")}`);
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
}
const stored = (page: Page) =>
  page.evaluate(async () => (await (window as any).__mockBackend.goalsRead()).thoughts ?? []);

test("thought dump: Enter adds a bullet and stays ready; edit in place; empty or ✕ deletes", async ({ page }) => {
  await open(page);
  const sec = page.getByTestId("thoughts-section");
  const add = sec.getByTestId("thought-add");
  await add.fill("which project should come next?");
  await add.press("Enter");
  await expect(add, "the field stays focused for the next one").toBeFocused();
  await add.fill("ask about the reading group");
  await add.press("Enter");
  const rows = sec.getByTestId("thought-row");
  await expect(rows).toHaveText(["•which project should come next?✕", "•ask about the reading group✕"]);
  expect((await stored(page)).map((t: { text: string }) => t.text)).toEqual(["which project should come next?", "ask about the reading group"]);

  // edit in place
  await rows.first().locator(".thought-text").dblclick();
  const ed = sec.locator(".thought-edit");
  await ed.fill("which project should come next, really?");
  await ed.press("Enter");
  await expect(rows.first()).toContainText("which project should come next, really?");
  // emptying deletes; ✕ deletes
  await rows.first().locator(".thought-text").dblclick();
  await sec.locator(".thought-edit").fill("");
  await sec.locator(".thought-edit").press("Enter");
  await expect(rows).toHaveCount(1);
  await rows.first().hover();
  await rows.first().getByRole("button", { name: "Delete thought" }).click();
  await expect(rows).toHaveCount(0);
  expect(await stored(page)).toEqual([]);
});

test("goals and the thought dump fold away, and stay folded", async ({ page }) => {
  await open(page);
  const goals = page.getByTestId("goals-section");
  await expect(goals.getByTestId("goal-group-daily")).toBeVisible();
  await page.getByTestId("goals-toggle").click();
  await expect(goals.getByTestId("goal-group-daily")).toHaveCount(0);
  await expect(page.getByTestId("goals-toggle")).toContainText("/"); // the tally shows when folded
  const add = page.getByTestId("thought-add");
  await add.fill("one thought");
  await add.press("Enter");
  await page.getByTestId("thoughts-toggle").click();
  await expect(page.getByTestId("thought-row")).toHaveCount(0);
  await expect(page.getByTestId("thoughts-toggle")).toContainText("1");
  await page.reload();
  await expect(page.locator(".mock-badge")).toHaveText("browser mock mode");
  await expect(goals.getByTestId("goal-group-daily")).toHaveCount(0);
  await expect(page.getByTestId("thought-add")).toHaveCount(0);
  // ＋ on folded goals opens them to add
  await page.getByTestId("goal-add").click();
  await expect(goals.getByTestId("goal-add-form")).toBeVisible();
  await expect(goals.getByTestId("goal-group-daily")).toBeVisible();
});

test("editing goals leaves the thought dump alone", async ({ page }) => {
  await open(page);
  const add = page.getByTestId("thought-add");
  await add.fill("keep me");
  await add.press("Enter");
  const row = page.getByTestId("goal-row").first();
  await row.hover();
  await row.getByRole("button", { name: "Delete goal" }).click();
  expect((await stored(page)).map((t: { text: string }) => t.text)).toEqual(["keep me"]);
});
