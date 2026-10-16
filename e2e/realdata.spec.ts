// Layout LAWS against the user's REAL week. The fixture is exported read-only
// from the app DB into e2e/fixtures/*.local.json (gitignored); without it this
// file skips, so it never fails on machines that lack the user's data.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probe } from "./textprobe";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const evPath = join(dir, "realweek.local.json");
const calPath = join(dir, "realcals.local.json");
const have = existsSync(evPath) && existsSync(calPath);

test.skip(!have, "no real-data fixture on this machine");

async function loadReal(page: Page, zoom = 0, now = "2026-10-15T01:30:00") {
  const rows = JSON.parse(readFileSync(evPath, "utf8"));
  const cals = JSON.parse(readFileSync(calPath, "utf8"));
  const fixture = {
    calendars: cals.map((c: any) => ({
      ...c,
      is_primary: !!c.is_primary,
      hidden: !!c.hidden,
    })),
    events: rows.map((r: any) => ({
      id: r.id,
      calendar_id: r.calendar_id,
      etag: null,
      summary: r.summary,
      description: r.description ?? null,
      location: r.location ?? null,
      start: r.start,
      end: r.end,
      all_day: !!r.all_day,
      timezone: null,
      status: "confirmed",
      recurrence: null,
      recurring_event_id: null,
      conference_url: null,
      updated: null,
      raw: null,
    })),
  };
  await page.addInitScript((fx) => {
    (globalThis as any).__calFixture = fx;
  }, fixture);
  await page.goto("/?now=" + encodeURIComponent(now));
  await expect(page.locator(".mock-badge")).toBeVisible();
  const sweep = page.getByTestId("sweep-banner");
  if (await sweep.count()) await sweep.locator(".toast-close").click();
  for (let i = 0; i < Math.abs(zoom); i++) {
    await page.keyboard.press(zoom < 0 ? "ControlOrMeta+Shift+," : "ControlOrMeta+Shift+.");
  }
}

async function lawProbe(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1500 });
  return page.evaluate(async () => {
    const blanks = new Set<string>();
    const hidden = new Map<string, true | string>(); // key -> visible, or why not
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const step = Math.max(200, grid.clientHeight - 200);
    for (let st = 0; ; st += step) {
      grid.scrollTop = st;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const gr = grid.getBoundingClientRect();
      const headerBottom =
        (grid.querySelector(".allday-row") as HTMLElement | null)?.getBoundingClientRect().bottom ?? gr.top;
      const lo = headerBottom + 2;
      const hi = gr.bottom - 2;
      for (const col of grid.querySelectorAll<HTMLElement>("[data-testid^=day-col-]")) {
        const cr = col.getBoundingClientRect();
        const boxes = [...col.querySelectorAll<HTMLElement>(".chip-timed, .cluster-block")]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { el, top: r.top, bottom: r.bottom };
          })
          .sort((a, b) => a.top - b.top);
        const comps: { top: number; bottom: number; n: number }[] = [];
        for (const b of boxes) {
          const last = comps[comps.length - 1];
          if (last && b.top < last.bottom - 0.5) {
            last.bottom = Math.max(last.bottom, b.bottom);
            last.n++;
          } else comps.push({ top: b.top, bottom: b.bottom, n: 1 });
        }
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
        for (const { el } of boxes) {
          const title = el.querySelector<HTMLElement>(".chip-title");
          if (!title) continue;
          const tr = title.getBoundingClientRect();
          if (tr.width === 0) continue;
          if (tr.top + 2 < lo || tr.bottom - 2 > hi) continue;
          const key = `${col.dataset.testid}: ${title.textContent}`;
          let why: string | null = null;
          for (let y = tr.top + Math.min(7, tr.height / 2); y < tr.bottom - 2; y += 14) {
            const hit = document.elementFromPoint(tr.left + 4, y) as HTMLElement | null;
            const owner = hit?.closest(".chip-timed, .cluster-block") as HTMLElement | null;
            if (owner !== el && !why) {
              why = `line at ${Math.round(y - cr.top)}px covered by ${
                owner ? `${(owner.title || owner.textContent || "").slice(0, 40)} (${owner.className.replace("chip chip-timed", "").trim().slice(0, 24)})` : `nothing: ${hit?.className ?? "off-screen"}`
              }`;
            }
          }
          if (!hidden.has(key) || !why) hidden.set(key, why ?? true);
        }
      }
      if (st + grid.clientHeight >= grid.scrollHeight) break;
    }
    return {
      blanks: [...blanks],
      hidden: [...hidden.entries()].filter(([, v]) => v !== true).map(([k, v]) => `${k} @ ${v}`),
    };
  });
}

const WEEKS = [
  "2026-09-16T12:00:00",
  "2026-09-23T12:00:00",
  "2026-09-30T12:00:00",
  "2026-10-07T12:00:00",
  "2026-10-15T01:30:00",
  "2026-10-21T12:00:00",
];
for (const now of WEEKS) {
  for (const [label, zoom] of [["default", 0], ["zoomed out", -1], ["zoomed in", 3]] as const) {
    test(`REAL WEEK LAW ${now.slice(5, 10)} (${label}): no blank space, every title visible`, async ({ page }) => {
      await loadReal(page, zoom, now);
      const { blanks, hidden } = await lawProbe(page);
      expect(hidden, "titles covered by other events").toEqual([]);
      expect(blanks, "blank space inside overlapping events").toEqual([]);
    });
  }
  for (const [label, zoom, width] of [
    ["default", 0, 1280],
    ["zoomed out", -2, 1280],
    ["zoomed in", 3, 1280],
    ["narrow", 0, 900],
  ] as const) {
    test(`REAL WEEK TEXT ${now.slice(5, 10)} (${label}): every title, time and note whole and uncovered`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1500 });
      await loadReal(page, zoom, now);
      const r = await probe(page);
      console.log(`[real ${now.slice(5, 10)} ${label}] events=${r.events} noTime=${r.noTime.length} notes=${r.noteCount}`);
      expect(r.text, "text covered or sticking out of its event").toEqual([]);
      expect(r.blank, "blank space inside overlapping events").toEqual([]);
      expect(r.notes, "margin notes cut, on text or on each other, or not tied to their event").toEqual([]);
    });
  }
}
