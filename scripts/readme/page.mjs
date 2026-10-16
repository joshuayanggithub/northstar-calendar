// Opens the app's browser mock on the demo week (scripts/readme/demo.mjs).
import { DEMO_NOW, calendars, events, goals, storage } from "./demo.mjs";

export const BASE = process.env.APP_URL ?? "http://127.0.0.1:1420";

/** clock: the page's timers run on a fake clock that only moves when the
 *  caller says so (page.clock.runFor), for frame-by-frame recording */
export async function openDemo(browser, { width = 1440, height = 900, scheme = "dark", query = "", dpr = 2, clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, colorScheme: scheme });
  const ls = storage();
  await ctx.addInitScript(
    ({ fixture, ls }) => {
      globalThis.__calFixture = fixture;
      if (!sessionStorage.getItem("demo-seeded")) {
        localStorage.clear();
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
        sessionStorage.setItem("demo-seeded", "1");
      }
    },
    { fixture: { calendars, events, goals }, ls },
  );
  const page = await ctx.newPage();
  if (clock) {
    await page.clock.install();
    faked.add(page);
  }
  await page.goto(`${BASE}/?now=${encodeURIComponent(DEMO_NOW)}${query}`);
  await page.locator(".mock-badge").waitFor({ state: "attached" });
  // the mock badge is a dev affordance, not part of the app
  await page.addStyleTag({ content: ".mock-badge{display:none!important}" });
  await settle(page, "[data-testid=margin-notes][data-pending='0']", 15000);
  return page;
}

const faked = new WeakSet();

/** wait for a selector, moving the page's fake clock along meanwhile */
export async function settle(page, selector, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.locator(selector).count()) return true;
    if (faked.has(page)) await page.clock.runFor(50);
    else await page.waitForTimeout(50);
  }
  return false;
}
