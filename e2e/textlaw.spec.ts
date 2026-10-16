// Text-visibility laws over generated overlap configurations (dummy calendar).
import { expect, test, type Page } from "@playwright/test";
import { canonicalWeek, randomWeek, type ScEvent } from "./scenarios";
import { probe } from "./textprobe";

const CALENDARS = [
  { id: "c-blue", summary: "Personal", color: "#4285f4", is_primary: true, hidden: false, access_role: "owner" },
  { id: "c-green", summary: "Work", color: "#0b8043", is_primary: false, hidden: false, access_role: "owner" },
  { id: "c-brown", summary: "Distractions", color: "#795548", is_primary: false, hidden: false, access_role: "owner" },
  { id: "c-gray", summary: "Deep Focus", color: "#616161", is_primary: false, hidden: false, access_role: "owner" },
  { id: "c-red", summary: "Learning", color: "#d50000", is_primary: false, hidden: false, access_role: "owner" },
];

function fixture(events: ScEvent[]) {
  return {
    calendars: CALENDARS,
    events: events.map((e, i) => ({
      id: `fx-${i}`,
      calendar_id: e.cal,
      etag: null,
      summary: e.title,
      description: e.drill ? `[DRILL] ${e.drill}` : null,
      location: e.location ?? null,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      all_day: false,
      timezone: null,
      status: "confirmed",
      recurrence: null,
      recurring_event_id: null,
      conference_url: null,
      updated: null,
      raw: null,
    })),
  };
}

interface Config {
  name: string;
  width: number;
  zoom: number; // negative = out, positive = in (12px/hour per step from 48)
  days?: string; // digit key for a custom day count
  seam?: "scarf" | "overlay";
}

const CONFIGS: Config[] = [
  { name: "week 48px/h", width: 1280, zoom: 0 },
  { name: "week 24px/h", width: 1280, zoom: -2 },
  { name: "week 36px/h", width: 1280, zoom: -1 },
  { name: "week 84px/h", width: 1280, zoom: 3 },
  { name: "week narrow", width: 900, zoom: 0 },
  { name: "3-day", width: 1280, zoom: 0, days: "3" },
  { name: "9-day narrow", width: 1000, zoom: 0, days: "9" },
  { name: "scarf joints", width: 1280, zoom: 0, seam: "scarf" },
  { name: "overlay (no joints)", width: 1280, zoom: 0, seam: "overlay" },
];

async function load(page: Page, events: ScEvent[], cfg: Config) {
  await page.addInitScript((fx) => {
    (globalThis as unknown as { __calFixture: unknown }).__calFixture = fx;
  }, fixture(events));
  if (cfg.seam) {
    await page.addInitScript((seam) => localStorage.setItem("overlapSeam", seam), cfg.seam);
  }
  await page.setViewportSize({ width: cfg.width, height: 1500 });
  // now = Sunday morning so the first day of the 3-day view is the first fixture day
  await page.goto("/?now=" + encodeURIComponent("2026-10-11T06:00:00"));
  await expect(page.locator(".mock-badge")).toBeVisible();
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  if (cfg.days) await page.keyboard.press(cfg.days);
  for (let i = 0; i < Math.abs(cfg.zoom); i++) {
    await page.keyboard.press(cfg.zoom < 0 ? "ControlOrMeta+Shift+," : "ControlOrMeta+Shift+.");
  }
  await page.waitForTimeout(100);
}

const WEEKS: [string, () => ScEvent[]][] = [
  ["canonical", () => canonicalWeek(7)],
  ["random-11", () => randomWeek(11)],
  ["random-23", () => randomWeek(23)],
];

for (const [weekName, gen] of WEEKS) {
  for (const cfg of CONFIGS) {
    test(`TEXT LAW ${weekName} / ${cfg.name}`, async ({ page }) => {
      await load(page, gen(), cfg);
      const r = await probe(page);
      const rules = await page.evaluate(() => {
        const n: Record<string, number> = {};
        for (const el of document.querySelectorAll<HTMLElement>("[data-testid^=day-col-] [data-text-rule]")) {
          n[el.dataset.textRule!] = (n[el.dataset.textRule!] ?? 0) + 1;
        }
        return Object.entries(n).map(([k, v]) => `${k}:${v}`).join(" ");
      });
      console.log(
        `[${weekName} / ${cfg.name}] rules ${rules} | events=${r.events} noTime=${r.noTime.length} cut=${r.cut.length}` +
          (r.noTime.length ? " :: " + r.noTime.map((n) => `${n.title} (${n.widthPx}x${n.heightPx})`).join(" ; ") : ""),
      );
      // SHOW_CUT=1 lists the titles shown cut (one-row events, mostly)
      if (process.env.SHOW_CUT) console.log(`CUT [${weekName} / ${cfg.name}]\n  ` + r.cut.join("\n  "));
      expect(r.text, "text covered or sticking out of its event").toEqual([]);
      expect(r.blank, "blank space inside overlapping events").toEqual([]);
      expect(r.align, "text block not aligned").toEqual([]);
      expect(r.notes, "margin notes cut, on text or on each other, or not tied to their event").toEqual([]);
    });
  }
}
