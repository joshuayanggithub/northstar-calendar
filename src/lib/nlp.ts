// Natural-language quick create: "lunch with Sam tue 12:30", "gym tomorrow 7am",
// "standup every weekday 10am" (recurrence is parsed but only the first
// occurrence is created until series-creation ships).

import * as chrono from "chrono-node";
import { now } from "./dates";

export interface ParsedQuickCreate {
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurrence?: string[];
  recurrenceLabel?: string;
}

const DEFAULT_DURATION_MIN = 60;

const DOW: Record<string, string> = {
  sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE",
  thursday: "TH", friday: "FR", saturday: "SA",
  sun: "SU", mon: "MO", tue: "TU", tues: "TU", wed: "WE",
  thu: "TH", thur: "TH", thurs: "TH", fri: "FR", sat: "SA",
};

/** Pull a recurrence phrase out of the text; returns [rrule, label, rest]. */
function extractRecurrence(text: string): [string[] | undefined, string | undefined, string] {
  let m = text.match(/\bevery\s+week\s*day(s)?\b/i) ?? text.match(/\bevery\s+weekday(s)?\b/i);
  if (m) {
    return [["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"], "every weekday", text.replace(m[0], " ")];
  }
  m = text.match(/\b(every\s+day|daily)\b/i);
  if (m) return [["RRULE:FREQ=DAILY"], "daily", text.replace(m[0], " ")];
  m = text.match(/\b(every\s+week|weekly)\b/i);
  if (m) return [["RRULE:FREQ=WEEKLY"], "weekly", text.replace(m[0], " ")];
  m = text.match(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i);
  if (m) {
    const day = DOW[m[1].toLowerCase()];
    // keep the weekday in the text so chrono anchors the first occurrence
    return [[`RRULE:FREQ=WEEKLY;BYDAY=${day}`], `every ${m[1].toLowerCase()}`, text.replace(/\bevery\b/i, " ")];
  }
  m = text.match(/\b(every\s+month|monthly)\b/i);
  if (m) return [["RRULE:FREQ=MONTHLY"], "monthly", text.replace(m[0], " ")];
  return [undefined, undefined, text];
}

export function parseQuickCreate(text: string, ref: Date = now()): ParsedQuickCreate | null {
  const pre = text.trim();
  if (!pre) return null;
  const [recurrence, recurrenceLabel, trimmedRaw] = extractRecurrence(pre);
  const trimmed = trimmedRaw.replace(/\s{2,}/g, " ").trim();
  if (!trimmed) return null;

  const results = chrono.parse(trimmed, ref, { forwardDate: true });
  if (results.length === 0) {
    // No date found: next full hour, 1h long.
    const start = new Date(ref);
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + DEFAULT_DURATION_MIN);
    return { title: trimmed, start, end, allDay: false, recurrence, recurrenceLabel };
  }

  const r = results[0];
  const start = r.start.date();
  const hasTime = r.start.isCertain("hour");
  let end: Date;
  if (r.end) {
    end = r.end.date();
  } else {
    end = new Date(start);
    if (hasTime) end.setMinutes(end.getMinutes() + DEFAULT_DURATION_MIN);
    else end.setDate(end.getDate() + 1); // all-day: exclusive end next day
  }

  // Title = text minus the date fragment, tidied.
  const title = (trimmed.slice(0, r.index) + trimmed.slice(r.index + r.text.length))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+(at|on|from|until|to|-)\s*$/i, "")
    .trim();

  return {
    title: title || "(no title)",
    start,
    end,
    allDay: !hasTime,
    recurrence,
    recurrenceLabel,
  };
}
