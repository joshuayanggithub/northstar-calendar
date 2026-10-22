// The hourly nudge's answer (lib/nudge.ts; the banner itself is native,
// src-tauri/src/notify.rs, tested by cargo): it opens on the event of yours
// in progress now, or on a new event for this hour.
import { expect, test } from "@playwright/test";
import { currentEvent, thisHour } from "../src/lib/nudge";
import type { Calendar, CalendarEvent } from "../src/lib/types";

const cal = (id: string, summary: string, access_role = "owner"): Calendar => ({ id, summary, color: "#4986e7", is_primary: id === "p", hidden: false, access_role });
const CALS = [cal("p", "Personal"), cal("sleep", "Sleep"), cal("school", "School", "reader")];
const ev = (id: string, calendar_id: string, summary: string, h0: number, h1: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, calendar_id, etag: null, summary, description: null, location: null,
  start: new Date(2026, 9, 17, Math.floor(h0), (h0 % 1) * 60).toISOString(),
  end: new Date(2026, 9, 17, Math.floor(h1), (h1 % 1) * 60).toISOString(),
  all_day: false, timezone: null, status: "confirmed", recurrence: null, recurring_event_id: null,
  conference_url: null, updated: null, raw: {}, ...extra,
});
const at = (h: number, m = 0) => new Date(2026, 9, 17, h, m);

test("nudge: opens the event you're in now; of several, the one that started last", () => {
  const evs = [
    ev("block", "p", "Deep work block", 13, 17),
    ev("call", "p", "Call with Mia", 14.5, 15),
    ev("later", "p", "Dinner", 18, 19),
  ];
  expect(currentEvent(evs, CALS, at(14, 40))?.id).toBe("call");
  expect(currentEvent(evs, CALS, at(15, 10))?.id).toBe("block");
  expect(currentEvent(evs, CALS, at(17, 30))).toBeNull(); // between events
});

test("nudge: never sleep, someone else's calendar, all-day or canceled events", () => {
  const evs = [
    ev("bed", "sleep", "Sleep", 0, 9),
    ev("class", "school", "Lecture", 8, 10),
    ev("allday", "p", "Offsite", 0, 24, { all_day: true }),
    ev("x", "p", "Gym", 8, 9, { status: "cancelled" }),
  ];
  expect(currentEvent(evs, CALS, at(8, 30))).toBeNull();
  const h = thisHour(at(8, 37));
  expect([h.start.getHours(), h.start.getMinutes(), h.end.getHours()]).toEqual([8, 0, 9]);
});

test("nudge: an event on a hidden calendar is not the one in progress", () => {
  const cals = [cal("p", "Personal"), { ...cal("work", "Work"), hidden: true }];
  const e = ev("w1", "work", "Standup", 9, 10);
  expect(currentEvent([e], cals, new Date(2026, 9, 17, 9, 30))).toBeNull();
});
