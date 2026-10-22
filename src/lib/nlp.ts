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
  sun: "SU", mon: "MO", tue: "TU", tues: "TU", wed: "WE", weds: "WE",
  thu: "TH", thur: "TH", thurs: "TH", fri: "FR", sat: "SA",
};

const DAY_RE = "(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)";
// whole month names only: a prefix match read "doctor", "Jane" and
// "Mark" as months ("Doctor 3-4 tomorrow" turned all-day)
const MONTH =
  "\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";

/** Pull a recurrence phrase out of the text; returns [rrule, label, rest]. */
function extractRecurrence(text: string): [string[] | undefined, string | undefined, string] {
  // "gym mon wed fri 7am": a list of days repeats weekly on them (one day
  // stays in the text so chrono anchors the first occurrence and its time)
  const list = text.match(new RegExp(`\\b(?:every\\s+)?(${DAY_RE}(?:\\s*(?:,|&|and|/)?\\s*${DAY_RE}\\b)+)`, "i"));
  if (list) {
    const days = list[1].match(new RegExp(DAY_RE, "gi")) ?? [];
    const codes = [...new Set(days.map((d) => DOW[d.toLowerCase()]))];
    if (codes.length >= 2) {
      return [[`RRULE:FREQ=WEEKLY;BYDAY=${codes.join(",")}`], `every ${days.map((d) => d.toLowerCase()).join(", ")}`,
        text.replace(list[0], ` ${days[0]} `)];
    }
  }
  // "every other friday", "biweekly", "every 2 weeks"
  // (not "every other month", "every 2 hours": those aren't biweekly)
  let m = text.match(/\b(?:biweekly|every\s+(?:other|2|two)(?:\s+weeks?)?)\b(?!\s+(?:days?|months?|years?|hours?|hrs?|minutes?|mins?)\b)/i);
  if (m) {
    const rest = text.replace(m[0], " ");
    const d = rest.match(new RegExp(`\\b(${DAY_RE})\\b`, "i"));
    const by = d ? `;BYDAY=${DOW[d[1].toLowerCase()]}` : "";
    return [[`RRULE:FREQ=WEEKLY;INTERVAL=2${by}`], d ? `every other ${d[1].toLowerCase()}` : "every other week", rest];
  }
  // "weekdays" needs no "every"
  m = text.match(/\b(?:every\s+week\s*days?|weekdays)\b/i);
  if (m) {
    return [["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"], "every weekday", text.replace(m[0], " ")];
  }
  m = text.match(/\b(every\s+day|daily)\b/i);
  if (m) return [["RRULE:FREQ=DAILY"], "daily", text.replace(m[0], " ")];
  m = text.match(/\b(every\s+week|weekly)\b/i);
  if (m) return [["RRULE:FREQ=WEEKLY"], "weekly", text.replace(m[0], " ")];
  m = text.match(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)\b/i);
  if (m) {
    const day = DOW[m[1].toLowerCase()];
    // keep the weekday in the text so chrono anchors the first occurrence
    return [[`RRULE:FREQ=WEEKLY;BYDAY=${day}`], `every ${m[1].toLowerCase()}`, text.replace(/\bevery\b/i, " ")];
  }
  // "office hours thursdays": a plural day repeats on it
  m = text.match(/\b(sun|mon|tues|wednes|thurs|fri|satur)days\b/i);
  if (m) {
    const day = `${m[1]}day`;
    return [[`RRULE:FREQ=WEEKLY;BYDAY=${DOW[day.toLowerCase()]}`], `every ${day.toLowerCase()}`, text.replace(m[0], ` ${day} `)];
  }
  m = text.match(/\b(every\s+month|monthly)\b/i);
  if (m) return [["RRULE:FREQ=MONTHLY"], "monthly", text.replace(m[0], " ")];
  return [undefined, undefined, text];
}

/** a bare hour (no am/pm) as people mean it: 8–11 morning, 12 noon,
 *  1–7 afternoon/evening */
function meridiemOf(h: number): "am" | "pm" {
  return h >= 8 && h <= 11 ? "am" : "pm";
}

/** Spell out times given without am/pm before chrono reads them (it takes
 *  them as morning: "call at 5" was 5 AM tomorrow), and bare hour ranges it
 *  doesn't read at all ("lunch 12-1" became an all-day "lunch 12-1"). */
function spellTimes(text: string, repeating = false): string {
  const noMeridiem = "(?!\\s*(?:am|pm|a\\.m|p\\.m|a\\b|p\\b|o'?clock))";
  // "9p", "12:30p": a bare a/p is am/pm (chrono doesn't read it; "call
  // tomorrow 9p" was an all-day "call 9p")
  text = text.replace(/\b(\d{1,2}(?::\d{2})?)([ap])\b(?!\.?m)/gi, "$1$2m");
  // chrono knows "tue" and "wed" but not "tues"/"weds" ("dentist tues 3pm" was today)
  text = text.replace(/\btues\b/gi, "tue").replace(/\bweds\b/gi, "wed");
  // noon as a range end: chrono read "noon-1" as noon at UTC-1 (9 AM here)
  text = text.replace(/\bnoon(?=\s*[-–]\s*\d)/gi, "12pm").replace(/(\d\s*[-–]\s*)noon\b/gi, "$112pm");
  // a part of the day settles a bare hour: "movie tonight 8" was 8 AM,
  // "gym tomorrow morning at 7" 7 PM; so do evening plans ("dinner at 8")
  const part = /\b(?:tonight|evening|night|dinner|drinks|party|movie|concert)\b/i.test(text) ? "pm"
    : /\b(?:morning|breakfast)\b/i.test(text) ? "am" : null;
  const mer = (h: number) => (part && h !== 12 ? part : meridiemOf(h));
  const minutes = (h: number, m?: string) => (h % 12) * 60 + Number(m ?? 0);
  // ranges: "9:30-11", or after a day or time word ("tomorrow 12-1",
  // "thursday 9-5", "from 2-4"). Not "nov 2-4", "12/3-12/5", "chapters
  // 3-4" or "room 4-5": days and numbers, not hours.
  const before = new RegExp(`(?:\\b(?:today|tonight|tomorrow|tmrw|morning|afternoon|evening|night|${DAY_RE}|from|at|between)|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?)\\s+$`, "i");
  // ("2-3 on friday", "9-11 next fri", "1-4 nov 12", "9-11 10/21" too)
  const after = new RegExp(`^\\s+(?:(?:(?:on|next|this)\\s+)?(?:today|tonight|tomorrow|tmrw|${DAY_RE})\\b|(?:on\\s+)?(?:${MONTH}\\s+\\d{1,2}\\b|\\d{1,2}/\\d{1,2}\\b))`, "i");
  // numbered things: "chapters 3-4", "room 4-5", "problems 1-6"
  const numbered = /\b(?:chapters?|ch|rooms?|rm|pages?|pp?|sections?|sec|lectures?|lec|units?|weeks?|wk|problems?|exercises?|ex|questions?|q|levels?|floors?|gates?|hw|homework|psets?|ps|slides?|steps?|parts?|seats?|rows?|verses?|episodes?|ep|seasons?)\.?\s+$/i;
  // am/pm on the end only ("11-1pm", "10-12pm"): the start is the latest
  // such hour before the end (chrono copied the end's pm: 11 PM to 1 PM)
  text = text.replace(
    new RegExp(`(?<![/\\d:])\\b(\\d{1,2})(?::(\\d{2}))?\\s*[-–]\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\b`, "gi"),
    (whole, h1: string, m1: string | undefined, h2: string, m2: string | undefined, ap: string, offset: number, all: string) => {
      const a = Number(h1), b = Number(h2);
      if (a < 1 || a > 12 || b < 1 || b > 12) return whole;
      if (new RegExp(`${MONTH}\\s+$`, "i").test(all.slice(0, offset))) return whole;
      const mb = ap.toLowerCase();
      const ma = minutes(a, m1) < minutes(b, m2) ? mb : mb === "am" ? "pm" : "am";
      return `${a}${m1 ? ":" + m1 : ""}${ma}-${b}${m2 ? ":" + m2 : ""}${mb}`;
    },
  );
  // am/pm on the start only ("9pm-12"): the end is the first such hour after it
  text = text.replace(
    new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)\\s*[-–]\\s*(\\d{1,2})(?::(\\d{2}))?(?![:\\d])${noMeridiem}`, "gi"),
    (whole, h1: string, m1: string | undefined, ap: string, h2: string, m2: string | undefined) => {
      const a = Number(h1), b = Number(h2);
      if (a < 1 || a > 12 || b < 1 || b > 12) return whole;
      const ma = ap.toLowerCase();
      const mb = minutes(b, m2) > minutes(a, m1) ? ma : ma === "am" ? "pm" : "am";
      return `${a}${m1 ? ":" + m1 : ""}${ma}-${b}${m2 ? ":" + m2 : ""}${mb}`;
    },
  );
  // ("3 to 5" too; (?!:\d) so "10:30-12:30pm" isn't cut at "12")
  text = text.replace(
    new RegExp(`(?<![/\\d])\\b(\\d{1,2})(?::(\\d{2}))?(?:\\s*[-–]\\s*|\\s+(?:to|until|till)\\s+)(\\d{1,2})(?::(\\d{2}))?(?!:\\d)\\b${noMeridiem}`, "gi"),
    (whole, h1: string, m1: string | undefined, h2: string, m2: string | undefined, offset: number, all: string) => {
      const a = Number(h1), b = Number(h2);
      if (a < 1 || a > 12 || b < 1 || b > 12) return whole;
      // (a repeating event's "every weekday 9-10" is a time too)
      // (with minutes it's a time: "lecture 6:30-8:30")
      if (!m1 && !m2 && numbered.test(all.slice(0, offset))) return whole;
      // right after a month name it's days: "nov 2-4"
      if (new RegExp(`${MONTH}\\s+$`, "i").test(all.slice(0, offset))) return whole;
      // ending the text ("deep work 9-11", "lunch 12-1") it's the time
      const last = all.slice(offset + whole.length).trim() === "";
      const context = repeating || last || before.test(all.slice(0, offset)) || after.test(all.slice(offset + whole.length));
      if (!m1 && !m2 && !context) return whole;
      const ma = /^0\d$/.test(h1) ? "am" : mer(a);
      // the end is the first such time after the start, in the start's half
      // of the day if it fits: 7-9 pm, 12-1 pm, 9-5 → 5 pm, 11-1 → 1 pm,
      // 9-9:15 → 9:15 am
      const mb = minutes(b, m2) > minutes(a, m1) ? ma : ma === "am" ? "pm" : "am";
      return `${a}${m1 ? ":" + m1 : ""}${ma}-${b}${m2 ? ":" + m2 : ""}${mb}`;
    },
  );
  // a bare hour right after a day word is a time: "dinner tomorrow 7",
  // "call friday 3" (it became an all-day "dinner 7"), "tomorrow morning 7".
  // Not a date ("saturday 7 november"), "9.30", or an amount ("3 hours")
  text = text.replace(
    new RegExp(`\\b(today|tonight|tomorrow|tmrw|${DAY_RE})((?:\\s+(?:morning|afternoon|evening|night))?)\\s+(\\d{1,2})\\b${noMeridiem}(?!\\s*[-–:/.])(?!\\s+(?:${MONTH}|hours?\\b|hrs?\\b|h\\b|min(?:ute)?s?\\b))`, "gi"),
    (whole, day: string, p: string, h1: string) => {
      const h = Number(h1);
      if (h < 1 || h > 12) return whole;
      return `${day}${p} ${h}${mer(h)}`;
    },
  );
  // single times: "at 5", "4:30" (a lone number is a date: "oct 5")
  text = text.replace(
    new RegExp(`\\b(at\\s+)(\\d{1,2})(?::(\\d{2}))?\\b${noMeridiem}|\\b(\\d{1,2}):(\\d{2})\\b${noMeridiem}`, "gi"),
    (whole, at: string | undefined, h1: string | undefined, m1: string | undefined, h2: string | undefined, m2: string | undefined) => {
      const h = Number(h1 ?? h2);
      const m = m1 ?? m2;
      // 24-hour "17:30" (chrono read "30 oct 21" out of "17:30 oct 21")
      if (m && h >= 13 && h <= 23) return `${at ?? ""}${h - 12}:${m}pm`;
      if (h < 1 || h > 12) return whole;
      // (a leading zero is a 24-hour clock: "07:15" is the morning)
      const zero = /^0\d$/.test(h1 ?? h2 ?? "");
      return `${at ?? ""}${h}${m ? ":" + m : ""}${zero ? "am" : mer(h)}`;
    },
  );
  return text;
}

export function parseQuickCreate(text: string, ref: Date = now()): ParsedQuickCreate | null {
  const pre = text.trim();
  if (!pre) return null;
  const [recurrence, recurrenceLabel, trimmedRaw] = extractRecurrence(pre);
  const trimmed = trimmedRaw.replace(/\s{2,}/g, " ").trim();
  if (!trimmed) return null;

  // "for 2h", "for 30 min" is the length, not part of the title
  // (a bare "30m" / "2h" beside a time too: "call 30m at 4" was a call at
  // 2:30, "30m" read as "in 30 minutes"; "24h fast" alone is a title)
  const dm = trimmed.match(/\s*\bfor\s+(\d+(?:\.\d+)?|an?|one)\s*(h|hrs?|hours?|m|mins?|minutes?)\b/i)
    ?? (() => {
      const bare = trimmed.match(/\s*(?<![\d:])(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?)\b/i);
      if (!bare) return null;
      const rest = trimmed.replace(bare[0], " ");
      const hasTime = /\b(?:at|@)\s*\d|\d\s*(?:am|pm|a\.m|p\.m|[ap])\b|\b\d{1,2}(?::\d{2})?\s*[-–]\s*\d|\bnoon\b|\bmidnight\b/i.test(rest);
      return hasTime ? bare : null;
    })();
  const durMin = dm ? (/^(an?|one)$/i.test(dm[1]) ? 1 : Number(dm[1])) * (/^h/i.test(dm[2]) ? 60 : 1) : null;
  let typed = dm ? trimmed.replace(dm[0], " ").replace(/\s{2,}/g, " ").trim() : trimmed;
  // "due the 21st", "on the 3rd": the next such day of the month
  // (only as a date: at the end, or before a time; "the 2nd draft", "the
  // 3rd floor" are things)
  typed = typed.replace(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b(?=\s*$|\s*[,;]|\s+(?:at|from|noon|midnight|morning|afternoon|evening|tonight|@|\d)|\s+(?:by|before|after|until)\s+(?:\d|noon|midnight))/i, (w, d: string) => {
    const day = Number(d);
    if (day < 1 || day > 31) return w;
    const month = new Date(ref.getFullYear(), ref.getMonth() + (day >= ref.getDate() ? 0 : 1), 1);
    return `${month.toLocaleString("en-US", { month: "short" })} ${day}`;
  });
  const spelled = spellTimes(typed, !!recurrence);
  // a number right before "oct 21" is the title's ("Lab 2 oct 21", "1:1 oct
  // 21"): chrono read it as the day and "21" as the year (Oct 2, 2021). Mask
  // it for chrono only; same length, so indexes still match `spelled`.
  // (not after a weekday, "tue 3 nov 1pm": that's the date; nor when what
  // follows the month is a time, "3 nov 1pm")
  const forChrono = spelled.replace(
    new RegExp(`(?<!\\d)(?<!\\b${DAY_RE}\\s+)\\d{1,2}(?=\\s+${MONTH}\\s+\\d{1,2}(?![\\d:]|\\s*(?:am|pm|a\\.m|p\\.m)\\b))`, "gi"),
    (d) => "#".repeat(d.length),
  );
  // and a bare unit in a title ("3D printing", "24h fast") isn't "in 3 days"
  const results = chrono.parse(forChrono, ref, { forwardDate: true })
    .filter((x) => !/^\d+\s*(?:d|h|m|w|y|hrs?|mins?|days?|hours?|weeks?|wks?)$/i.test(x.text))
    // (chrono's word boundary is ASCII: "Pokémon" gave a Monday)
    .filter((x) => !/\p{L}/u.test(forChrono[x.index - 1] ?? "") && !/\p{L}/u.test(forChrono[x.index + x.text.length] ?? ""));
  if (results.length === 0) {
    // No date found: next full hour, 1h long.
    const start = new Date(ref);
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + DEFAULT_DURATION_MIN);
    return { title: trimmed, start, end, allDay: false, recurrence, recurrenceLabel };
  }

  // a day and a time typed apart are one event ("tomorrow gym 7am" was an
  // all-day "gym 7am"); a day+time beats a title word that reads as a date
  // ("Wed planning thu 9am", "June bday 5pm")
  let r = results[0];
  let time: chrono.ParsedResult | undefined;
  if (!r.start.isCertain("hour")) {
    const timed = results.find((x) => x.start.isCertain("hour"));
    const onDay = (x: chrono.ParsedResult) => x.start.isCertain("day") || x.start.isCertain("weekday");
    if (timed && (onDay(timed) || timed.start.isCertain("month") || !onDay(r))) r = timed;
    else if (timed) time = timed;
  }
  const start = r.start.date();
  const hasTime = r.start.isCertain("hour") || !!time;
  let end: Date;
  if (time) {
    const t = time.start.date();
    start.setHours(t.getHours(), t.getMinutes(), 0, 0);
    end = new Date(start);
    if (time.end) end.setHours(time.end.date().getHours(), time.end.date().getMinutes(), 0, 0);
    else end.setMinutes(end.getMinutes() + DEFAULT_DURATION_MIN);
  } else if (r.end) {
    end = r.end.date();
    // "dec 20 - dec 23" means through the 23rd: all-day ends are exclusive
    if (!hasTime) end.setDate(end.getDate() + 1);
  } else {
    end = new Date(start);
    if (hasTime) end.setMinutes(end.getMinutes() + DEFAULT_DURATION_MIN);
    else end.setDate(end.getDate() + 1); // all-day: exclusive end next day
  }
  // a named day's midnight is the one that ends it ("due fri midnight" was
  // Thursday night, "tomorrow midnight" tonight); "tonight at midnight" was noon
  // (midnight as the start only: "9pm until midnight" ends there)
  if (hasTime && !r.end && !time?.end && /\bmidnight\b/i.test(r.text)) {
    const named = r.text.replace(/\b(?:at\s+)?midnight\b/i, "").trim();
    // (a dated midnight too: "oct 20 midnight" is the night ending the 20th)
    if (named && !/\d\s*(?:am|pm|a\.m|p\.m|:\d)/i.test(named)) {
      const day = /\b(?:tonight|today)\b/i.test(named) ? new Date(ref)
        : /\b(?:tomorrow|tmrw)\b/i.test(named) ? new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1)
        : new Date(start);
      day.setDate(day.getDate() + 1);
      day.setHours(0, 0, 0, 0);
      start.setTime(day.getTime());
      end.setTime(day.getTime() + DEFAULT_DURATION_MIN * 60_000);
    }
  }
  if (durMin && hasTime && !r.end && !time?.end) end.setTime(start.getTime() + durMin * 60_000);
  // an overnight range ends the next day: chrono put "party fri 10pm-1am"'s
  // end on Friday, before its start (stored, never drawn)
  if (hasTime) while (end <= start) end.setDate(end.getDate() + 1);

  // a repeating event starts on a day it repeats on ("every weekday" typed
  // on a Saturday started on Sunday)
  const byday = recurrence?.[0]?.match(/BYDAY=([A-Z,]+)/)?.[1]?.split(",");
  if (byday && byday.length > 1 && recurrenceLabel?.includes(",")) {
    // a typed list of days ("mon wed fri"): the first of them from now on,
    // not the first one named (on a Wednesday that's Friday, not Monday)
    const span = end.getTime() - start.getTime();
    const first = new Date(ref);
    first.setHours(start.getHours(), start.getMinutes(), 0, 0);
    const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    // (an all-day one counts today whatever the hour; a timed one only if
    // its time is still ahead)
    const past = (d: Date) => hasTime ? d <= ref : d.toDateString() !== ref.toDateString() && d < ref;
    for (let i = 0; i < 8 && (!byday.includes(codes[first.getDay()]) || past(first)); i++) {
      first.setDate(first.getDate() + 1);
    }
    start.setTime(first.getTime());
    end.setTime(first.getTime() + span);
  }
  if (byday) {
    const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    for (let i = 0; i < 7 && !byday.includes(codes[start.getDay()]); i++) {
      start.setDate(start.getDate() + 1);
      end.setDate(end.getDate() + 1);
    }
  }

  // Title = text minus the date (and time) fragments, tidied.
  let rest = spelled;
  for (const x of [r, time].filter((x): x is chrono.ParsedResult => !!x).sort((a, b) => b.index - a.index)) {
    rest = rest.slice(0, x.index) + " " + rest.slice(x.index + x.text.length);
  }
  const title = rest
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
