// Opt-in: the focus score over real days, for calibration and the table in
// design/focus-score.md. Never runs by default (the data is private):
//   CALIBRATE=1 FOCUS_DATA=/path/with/{cals,events,recon}.json npx playwright test focus.calibrate
// cals/events: the app's Calendar / CalendarEvent shapes (hidden calendars
// are dropped, as in the week view); recon: the app's "recon" localStorage map.
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { focusScore } from "../src/lib/insights";
import type { Calendar, CalendarEvent } from "../src/lib/types";

test("calibrate: focus score over real days", () => {
  test.skip(!process.env.CALIBRATE || !process.env.FOCUS_DATA, "opt-in (CALIBRATE=1 FOCUS_DATA=dir)");
  const dir = process.env.FOCUS_DATA!;
  const calendars: Calendar[] = JSON.parse(readFileSync(`${dir}/cals.json`, "utf8"));
  const hidden = new Set(calendars.filter((c) => c.hidden).map((c) => c.id));
  const events: CalendarEvent[] = JSON.parse(readFileSync(`${dir}/events.json`, "utf8")).filter(
    (e: CalendarEvent) => !hidden.has(e.calendar_id),
  );
  const recon: Record<string, { s: "done" | "canceled"; at: number }> = JSON.parse(readFileSync(`${dir}/recon.json`, "utf8"));
  const since = Math.min(...Object.values(recon).map((v) => v.at));
  const now = new Date(process.env.FOCUS_NOW ?? "2026-10-16T01:00:00");
  const rows: string[] = [];
  const scores: number[] = [];
  for (let d = new Date(2026, 8, 13); d < new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); d.setDate(d.getDate() + 1)) {
    const f = focusScore({
      day: d,
      now,
      events,
      calendars,
      recon: (e) => recon[`${e.calendar_id}/${e.id}`]?.s ?? null,
      reconSince: since,
    });
    if (!f.hasData) continue;
    scores.push(f.score);
    const r = (x: number) => Math.round(x);
    rows.push(
      [
        d.toDateString().slice(0, 10),
        f.score,
        f.work.toFixed(2),
        f.restraint.toFixed(2),
        f.recovery.toFixed(2),
        r(f.loggedMin),
        r(f.deepMin),
        r(f.longestMin),
        f.interruptions,
        r(f.distractionMin),
        r(f.lateDistractionMin),
        f.sleep ? f.sleep.hours.toFixed(1) : "–",
        r(f.pendingMin),
        f.reason,
      ].join(" | "),
    );
  }
  const s = [...scores].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  console.log(
    "day | score | work | restraint | recovery | logged | credited | longest | interruptions | distraction | late dist | sleep h | pending | reason\n" +
      rows.join("\n") +
      `\n${s.length} days: min ${s[0]} · p25 ${q(0.25)} · median ${q(0.5)} · p75 ${q(0.75)} · max ${s[s.length - 1]}`,
  );
});
