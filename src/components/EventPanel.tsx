// Docked event editor matching Notion Calendar's sidebar row-for-row:
// [Event ⌄  ⋯ ✕] · Title · 🕐 start → end (dur) · pretty date ·
// All-day / Time zone / Repeat · 👤 Participants · 📹 Conferencing ·
// 📍 Location · ─ Description ─ · ⬛ Calendar · Busy/Visibility · 🔔 Reminders.
// Enter / ⌘Enter saves, Esc dismisses.

import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { eventDates, format, toDateOnly, toLocalISO, fmtTimeShort, now } from "../lib/dates";
import { isCanceled, reconExempt, reconKey, reconState, setRecon, subscribeRecon, toggleCanceled } from "../lib/recon";
import { calendarEditable } from "../lib/types";
import type { Backend, Calendar, CalendarEvent, EventInput } from "../lib/types";
import type { DraftEvent } from "./WeekView";
import type { EventActions } from "./App";
import { colorOf } from "../lib/useBackend";
import { CopyTargets } from "./CopyTargets";
import { geocodeOne, gmapsUrl, osmEmbedUrl, searchPlaces, type Place } from "../lib/places";
import { setStarGoal, starKey, starState, subscribeStars } from "../lib/stars";
import { useGoals } from "../lib/goals";
import { cleanDrill, joinDrill, splitDrill } from "../lib/drill";
import { guestsOf, myRsvp, rsvpTally, type Guest, type Rsvp } from "../lib/rsvp";

export type PanelState =
  | { mode: "closed" }
  | { mode: "view"; event: CalendarEvent; anchor?: { x: number; y: number } }
  | { mode: "new"; draft: DraftEvent; anchor?: { x: number; y: number } };

function tMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function tStr(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** the calendar day before (not 24h before: across a DST change that lands
 *  on the wrong day, and an all-day event lost its last day on Save) */
function dayBefore(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() - 1);
  return x;
}

function calendarDayOffset(start: Date, end: Date): number {
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((endDay - startDay) / 86400000));
}

function durationLabel(startTime: string, endTime: string, endDayOffset: number, date?: string): string {
  let mins: number;
  if (date) {
    const start = new Date(`${date}T${startTime}:00`);
    const end = new Date(`${date}T${endTime}:00`);
    end.setDate(end.getDate() + endDayOffset);
    mins = Math.round((end.getTime() - start.getTime()) / 60000);
  } else {
    mins = tMin(endTime) - tMin(startTime) + endDayOffset * 1440;
  }
  // (zero-length events exist: Google allows them, a deadline say)
  if (mins < 0) mins = 30;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

const REPEAT_PRESETS: [string, string | null][] = [
  ["Doesn't repeat", null],
  ["Daily", "RRULE:FREQ=DAILY"],
  ["Weekly", "RRULE:FREQ=WEEKLY"],
  ["Weekdays", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
  ["Monthly", "RRULE:FREQ=MONTHLY"],
];

/** the reminder select's "No reminder" (Google: useDefault false, no
 *  overrides); null is the calendar's default */
const NO_REMINDER = -1;
const REMINDER_CHOICES: [string, number | null][] = [
  ["Default reminder", null],
  ["No reminder", NO_REMINDER],
  ["At time of event", 0],
  ["10 min before", 10],
  ["30 min before", 30],
  ["1 hour before", 60],
  ["1 day before", 1440],
];

/** the select's value for an event's reminders (its first override, none,
 *  or the calendar's default) */
function reminderOf(raw: any): number | null {
  const r = raw?.reminders;
  if (r?.useDefault !== false) return null;
  const ov = r.overrides?.[0]?.minutes;
  return typeof ov === "number" ? ov : NO_REMINDER;
}
/** what Save sends for the select's value */
function reminderFields(m: number | null): Pick<EventInput, "reminder_minutes" | "reminders"> {
  return m === NO_REMINDER
    ? { reminders: { useDefault: false, overrides: [] }, reminder_minutes: undefined }
    : { reminder_minutes: m };
}

const isEmail = (v: string) => /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(v);
/** addresses compare without case: "ann@x.com" is the guest "Ann@X.com" */
const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hasEmail = (list: string[], v: string) => list.some((x) => sameEmail(x, v));
/** a typed or pasted guest list: "Ann Lee <ann@x.com>, bob@y.com" gives
 *  the addresses (a name around an <address> is dropped) */
function guestTokens(s: string): string[] {
  const out: string[] = [];
  for (const piece of s.split(/[,;]+/)) {
    const bracketed = piece.match(/<([^<>\s]+@[^<>\s]+)>/);
    if (bracketed) out.push(bracketed[1]);
    else out.push(...piece.split(/\s+/).map((v) => v.trim()).filter(Boolean));
  }
  return out;
}

function reminderLabel(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"} before`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"} before`;
  return `${min} min before`;
}

/** Google web saves descriptions as HTML (links, line breaks): shown as text */
export function htmlToText(s: string): string {
  // only real markup: "Ann <ann@example.com>" in plain text is not a tag
  if (!/<\/?(a|br|p|div|span|b|i|u|em|strong|ul|ol|li)\b[^>]*>/i.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return !t || t === href ? href : `${t} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const Icon = {
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  people: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
      <path d="M16 5.5a3.5 3.5 0 0 1 0 5.4M18.5 15.2c1.6.8 2.7 2.2 3 4.8" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
      <path d="M15.5 10.5 21 7v10l-5.5-3.5" />
    </svg>
  ),
  pin: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21s-7-5.1-7-11a7 7 0 0 1 14 0c0 5.9-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </svg>
  ),
  review: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.4 2.4 2.4 4.6-5" />
    </svg>
  ),
  tick: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 8.4 2.9 2.9 6-6.4" />
    </svg>
  ),
};


/** Notion-style time field: the native input stays (typing, arrows), and
 *  focusing it opens a 15-minute option list; end-time options carry the
 *  duration from the start ("(30 mins)", "(1 hr)"). */
function TimeField(props: {
  value: string;
  disabled?: boolean;
  relativeTo?: string; // start time: show durations and begin the list there
  /** the event's day: durations are elapsed time (a DST day's 1:30–3:30 is 1h) */
  date?: string;
  /** fromList: picked from the list, whose times run on past midnight */
  onPick: (v: string, fromList?: boolean) => void;
  testid?: string;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const opts = useMemo(() => {
    const base = props.relativeTo ? tMin(props.relativeTo) : 0;
    const out: { v: string; label: string; sub?: string }[] = [];
    for (let i = props.relativeTo ? 1 : 0; i < 96 + (props.relativeTo ? 1 : 0); i++) {
      const m = (base + i * 15) % 1440;
      const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
      out.push({
        v: tStr(m),
        label: fmtTimeShort(d),
        sub: props.relativeTo ? durationLabel(props.relativeTo, tStr(m), base + i * 15 >= 1440 ? 1 : 0, props.date) : undefined,
      });
    }
    return out;
  }, [props.relativeTo, props.date]);
  useEffect(() => {
    if (!open || !listRef.current) return;
    // (the end list runs on past midnight: minutes relative to its base,
    // or 11:15 PM matched before an overnight event's 7 AM)
    const base = props.relativeTo ? tMin(props.relativeTo) : 0;
    const rel = (t: string) => (((tMin(t) - base) % 1440) + 1440) % 1440;
    const idx = opts.findIndex((o: { v: string }) => o.v === props.value || rel(o.v) >= rel(props.value));
    const el = listRef.current.children[Math.max(0, idx)] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "center" });
  }, [open, opts, props.value]);
  // WebKit draws the native field as "03 : 15  AM"; it's shown only while
  // being typed in, under a plain "3:15 AM" otherwise
  const label = (() => {
    const m = tMin(props.value);
    if (!Number.isFinite(m)) return "";
    const h = Math.floor(m / 60) % 24;
    return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  })();
  return (
    <span className="timefield">
      <span className="timefield-label" aria-hidden="true">{label}</span>
      <input
        type="time"
        value={props.value}
        disabled={props.disabled}
        data-testid={props.testid}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onChange={(e) => e.target.value && props.onPick(e.target.value)}
      />
      {open && !props.disabled && (
        <div className="time-pop" ref={listRef} data-testid="time-pop" tabIndex={-1}>
          {opts.map((o) => (
            <button
              key={o.v}
              tabIndex={-1}
              className={"time-opt" + (o.v === props.value ? " active" : "")}
              onPointerDown={(e) => {
                e.preventDefault();
                props.onPick(o.v, true);
                setOpen(false);
              }}
            >
              {o.label}
              {o.sub && <span className="time-opt-sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

const GUEST_ANSWER: Record<string, string> = {
  accepted: "accepted", declined: "declined", tentative: "maybe", needsAction: "awaiting", new: "not invited yet",
};
const RSVP_BUTTON: Record<string, string> = { accepted: "Yes", declined: "No", tentative: "Maybe" };
/** a steady hue per address, for its avatar */
function hueOf(email: string): number {
  let h = 0;
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
const initialOf = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

/** A textarea as tall as its text (never shorter than `rows`): a long
 *  description reads in full, the panel scrolls instead of the box. It
 *  re-fits when the panel is resized, since the lines re-wrap. */
/** the first day from `date` (YYYY-MM-DD) that an RRULE's BYDAY lists;
 *  `date` itself when the rule has none */
function firstRepeatDay(date: string, rule: string): string {
  const by = rule.match(/(?:^|;)BYDAY=([A-Z,]+)/)?.[1];
  if (!by) return date;
  const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const days = new Set(by.split(",").map((c) => codes.indexOf(c)).filter((n) => n >= 0));
  if (!days.size) return date;
  const d = new Date(`${date}T00:00:00`);
  for (let i = 0; i < 7 && !days.has(d.getDay()); i++) d.setDate(d.getDate() + 1);
  return toDateOnly(d);
}

export function GrowingTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [props.value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} {...props} />;
}

export function EventPanel(props: {
  backend: Backend | null;
  calendars: Calendar[];
  state: PanelState;
  actions: EventActions;
  onClose: () => void;
  /** the open event as currently stored (fresher than state.event, which
   *  is the snapshot it was opened with); null when it isn't loaded */
  liveEvent?: CalendarEvent | null;
  /** the calendar shown on its own (Isolate), if any */
  isolated?: string | null;
}) {
  const { state, calendars } = props;
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [allDayEnd, setAllDayEnd] = useState(""); // last covered day (inclusive)
  const [dateEditing, setDateEditing] = useState(false);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [allDay, setAllDay] = useState(false);
  const [endDayOffset, setEndDayOffset] = useState(0);
  const [calendarId, setCalendarId] = useState("");
  const [calendarMenuOpen, setCalendarMenuOpen] = useState(false);
  const calendarPickerRef = useRef<HTMLDivElement | null>(null);
  const [location, setLocation] = useState("");
  const [locSuggestions, setLocSuggestions] = useState<Place[]>([]);
  const [locOpen, setLocOpen] = useState(false);
  const [locActive, setLocActive] = useState(0);
  const [locCoords, setLocCoords] = useState<{ lat: number; lon: number } | null>(null);
  const locPicked = useRef<string | null>(null);
  const [description, setDescription] = useState("");
  const [drill, setDrill] = useState<string | null>(null);
  const [withMeet, setWithMeet] = useState(false);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [attendeeInput, setAttendeeInput] = useState("");
  const [transparency, setTransparency] = useState("opaque");
  const [visibility, setVisibility] = useState("default");
  const [reminderMin, setReminderMin] = useState<number | null>(null);
  const [repeatRule, setRepeatRule] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Enter can arrive twice before the first save resolves (the button is
  // disabled while busy, the key handler isn't): one save at a time.
  const savingRef = useRef(false);
  /** All-day switched off: its last day, and the times it left, to restore
   *  the span if switched straight back on */
  const allDayOffRef = useRef<{ allDayEnd: string; times: string } | null>(null);
  const [, starTick] = useState(0);
  useEffect(() => subscribeStars(() => starTick((n) => n + 1)), []);
  useEffect(() => subscribeRecon(() => starTick((n) => n + 1)), []);
  const goals = useGoals(props.backend);
  const goalOptions = useMemo(() => goals.file.goals.map((g) => g.text), [goals.file]);
  const [error, setError] = useState<string | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  // an isolated calendar is where a new event goes (on the primary it
  // vanished from the isolated view on Save)
  const isolatedCal = props.isolated ? calendars.find((c) => c.id === props.isolated && calendarEditable(c)) : undefined;
  const defaultCalendarId = isolatedCal?.id ??
    calendars.find((c) => c.is_primary && calendarEditable(c))?.id ?? calendars.find(calendarEditable)?.id ?? "";
  const [copyOpen, setCopyOpen] = useState(false);
  const openKey = state.mode === "view" ? `${state.event.calendar_id}/${state.event.id}` : state.mode;
  useEffect(() => setCopyOpen(false), [openKey]);

  useEffect(() => {
    setBusy(false);
    setError(null);
    setWithMeet(false);
    setMenuOpen(false);
    allDayOffRef.current = null; // (an All-day switched off on the last event shaped this one's span)
    setCalendarMenuOpen(false);
    setDateEditing(false);
    setAttendeeInput("");
    setRepeatRule(null);
    if (state.mode === "view") {
      const e = state.event;
      const { start, end } = eventDates(e);
      setTitle(e.summary);
      setDate(toDateOnly(start));
      setAllDayEnd(
        e.all_day ? toDateOnly(dayBefore(end)) : toDateOnly(start),
      );
      setStartTime(format(start, "HH:mm"));
      setEndTime(format(end, "HH:mm"));
      setEndDayOffset(e.all_day ? 0 : calendarDayOffset(start, end));
      setAllDay(e.all_day);
      setCalendarId(e.calendar_id);
      setLocation(e.location ?? "");
      setLocCoords(null);
      locPicked.current = e.location ?? null;
      {
        const parts = splitDrill(e.description);
        setDescription(htmlToText(parts.body));
        // as the margin shows it: without the model's stage directions
        setDrill(cleanDrill(parts.drill, e.summary));
      }
      const raw = e.raw ?? {};
      setAttendees((raw.attendees ?? []).map((a: any) => a.email).filter(Boolean));
      setTransparency(raw.transparency ?? "opaque");
      setVisibility(raw.visibility ?? "default");
      setReminderMin(reminderOf(raw));
    } else if (state.mode === "new") {
      const d = state.draft;
      setTitle("");
      setEndDayOffset(d.allDay ? 0 : calendarDayOffset(d.start, d.end));
      setDate(toDateOnly(d.start));
      setAllDayEnd(
        d.allDay ? toDateOnly(dayBefore(d.end)) : toDateOnly(d.start),
      );
      setStartTime(format(d.start, "HH:mm"));
      setEndTime(format(d.end, "HH:mm"));
      setAllDay(d.allDay);
      setCalendarId(defaultCalendarId);
      setLocation("");
      setLocCoords(null);
      locPicked.current = null;
      setDescription("");
      setDrill(null);
      setAttendees([]);
      // an all-day draft (the all-day lane, a month day) is Free, as Google
      // does and as toggling All day sets
      setTransparency(d.allDay ? "transparent" : "opaque");
      setVisibility("default");
      setReminderMin(null);
    }
  // Not `calendars`: every db change (a note saved, a sync pass) refetches
  // the list as a new array, and resetting on that put the opened snapshot
  // back into every field: the erased note reappeared and the panel flashed.
  // Nor the default calendar: it changes when an isolated calendar is shown
  // again (the pill's Show all), and that reset the open editor's edits.
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  // a new event opened before the calendars loaded takes the default once
  // there is one
  useEffect(() => {
    if (state.mode === "new" && !calendarId && defaultCalendarId) setCalendarId(defaultCalendarId);
  }, [state.mode, calendarId, defaultCalendarId]);

  // The note saves on its own (here, Delete on its margin note, or the
  // supervisor), unlike the other fields, which are a draft until Save. So
  // show the stored note: a stale copy here was written back by the next
  // Save, re-adding a note that had been erased.
  const live = state.mode === "view" ? props.liveEvent : null;
  const liveDrill = live ? cleanDrill(splitDrill(live.description).drill, live.summary) : undefined;
  const liveDrillRef = useRef(liveDrill);
  liveDrillRef.current = liveDrill;
  useEffect(() => {
    if (liveDrill !== undefined) setDrill(liveDrill);
  }, [liveDrill]);

  const readOnly =
    state.mode === "view" &&
    !calendarEditable(calendars.find((c) => c.id === state.event.calendar_id));

  useEffect(() => {
    if (!calendarMenuOpen) return;
    calendarPickerRef.current?.querySelector<HTMLButtonElement>('.panel-cal-option[aria-selected="true"]')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!calendarPickerRef.current?.contains(event.target as Node)) {
        setCalendarMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [calendarMenuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".panel-menu, .panel-head-actions")) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);

  // location autocomplete: debounce keystrokes; a picked/saved value geocodes
  // once for the map preview instead of re-querying.
  useEffect(() => {
    const q = location.trim();
    if (q.length < 3 || readOnly) {
      setLocSuggestions([]);
      setLocOpen(false);
      return;
    }
    if (locPicked.current === location) {
      if (!locCoords) {
        const ctl = new AbortController();
        geocodeOne(q, ctl.signal)
          .then((p) => p && setLocCoords({ lat: p.lat, lon: p.lon }))
          .catch(() => {});
        return () => ctl.abort();
      }
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(q, ctl.signal)
        .then((list) => {
          setLocSuggestions(list);
          setLocOpen(list.length > 0);
          setLocActive(0);
        })
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, readOnly]);

  const pickPlace = (p: Place) => {
    locPicked.current = p.label;
    setLocation(p.label);
    setLocCoords({ lat: p.lat, lon: p.lon });
    setLocSuggestions([]);
    setLocOpen(false);
  };

  if (state.mode === "closed") return null;

  const toggleAllDay = (checked: boolean) => {
    setAllDay(checked);
    const off = allDayOffRef.current;
    allDayOffRef.current = null;
    if (checked && off && off.times === `${startTime}|${endTime}|${endDayOffset}`) {
      // straight back on (times untouched since): the span it had
      setAllDayEnd(off.allDayEnd);
    } else if (checked && date) {
      // the days the timed event covers (its end may be a later day; an end
      // at midnight doesn't cover that day): a stale last day was kept
      const end = new Date(`${date}T${endTime}:00`);
      end.setDate(end.getDate() + endDayOffset);
      const last = toDateOnly(new Date(end.getTime() - 1));
      setAllDayEnd(last > date ? last : date);
    }
    // a new all-day event is Free by default, as in Google Calendar
    if (state.mode === "new") setTransparency(checked ? "transparent" : "opaque");
    if (!checked && startTime === "00:00" && endTime === "00:00") {
      setStartTime("09:00");
      setEndTime("10:00");
      setEndDayOffset(0);
      allDayOffRef.current = { allDayEnd, times: "09:00|10:00|0" };
    } else if (!checked) {
      allDayOffRef.current = { allDayEnd, times: `${startTime}|${endTime}|${endDayOffset}` };
    }
  };

  const changeStartDate = (nextDate: string) => {
    // a cleared date segment is not a date (it saved start: "")
    if (!nextDate) return;
    if (allDay && date && nextDate) {
      // `allDayEnd` is the last covered day, inclusive. Move it by the same
      // calendar-day delta as the start so shifting a multi-day block keeps
      // its span instead of leaving the old end date behind.
      const oldStart = new Date(`${date}T00:00:00`);
      const oldLastDay = new Date(`${allDayEnd && allDayEnd > date ? allDayEnd : date}T00:00:00`);
      const spanOffset = calendarDayOffset(oldStart, oldLastDay);
      const nextLastDay = new Date(`${nextDate}T00:00:00`);
      nextLastDay.setDate(nextLastDay.getDate() + spanOffset);
      setAllDayEnd(toDateOnly(nextLastDay));
    } else if (!allDay && date && allDayOffRef.current) {
      // the span kept for "All-day back on" moves with the start too (a
      // 3-day block switched off, moved a week earlier, switched back on
      // kept its old last day: 7 days)
      const off = allDayOffRef.current;
      // (signed: calendarDayOffset is a span, never negative)
      const delta = Math.round((Date.parse(`${nextDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
      const end = new Date(`${off.allDayEnd}T00:00:00`);
      end.setDate(end.getDate() + delta);
      allDayOffRef.current = { ...off, allDayEnd: toDateOnly(end) };
    }
    setDate(nextDate);
  };

  const addAttendee = () => {
    // a pasted list adds every address; what isn't one stays to be fixed
    const parts = guestTokens(attendeeInput);
    const valid = parts.filter(isEmail);
    const fresh = valid.filter((v, i) => !hasEmail(attendees, v) && valid.findIndex((x) => sameEmail(x, v)) === i);
    if (fresh.length) setAttendees((a) => [...a, ...fresh]);
    setAttendeeInput(parts.filter((v) => !valid.includes(v)).join(", "));
  };

  const buildInput = (): EventInput => {
    // a new series starts on a day it repeats on: Weekdays picked on a
    // Saturday gave Google a stray Saturday occurrence (DTSTART counts)
    const day = state.mode === "new" && repeatRule ? firstRepeatDay(date, repeatRule) : date;
    // a guest typed but not yet entered (⌘Enter, or Save) counts too
    const typed = guestTokens(attendeeInput).filter(isEmail);
    const withTyped = [...attendees, ...typed.filter((v, i) => !hasEmail(attendees, v) && typed.findIndex((x) => sameEmail(x, v)) === i)];
    const start = allDay ? day : toLocalISO(new Date(`${day}T${startTime}:00`));
    let end: string;
    if (allDay) {
      const last = allDayEnd && allDayEnd > day ? allDayEnd : day;
      const d = new Date(`${last}T00:00:00`);
      d.setDate(d.getDate() + 1);
      end = toDateOnly(d);
    } else {
      let endD = new Date(`${day}T${endTime}:00`);
      const startD = new Date(`${day}T${startTime}:00`);
      endD.setDate(endD.getDate() + endDayOffset);
      // (an end before the start is a slip; one at the start is a
      // zero-length event, kept as Google keeps it)
      if (endDayOffset === 0 && endD < startD) {
        endD = new Date(startD.getTime() + 30 * 60000);
      }
      end = toLocalISO(endD);
    }
    return {
      calendar_id: calendarId,
      summary: title.trim() || "(no title)",
      description: joinDrill(description, drill) || null,
      location: location || null,
      start,
      end,
      all_day: allDay,
      with_meet: withMeet || undefined,
      recurrence: state.mode === "new" && repeatRule ? [repeatRule] : undefined,
      attendees: withTyped.length > 0 ? withTyped : state.mode === "view" ? [] : undefined,
      transparency,
      visibility,
      ...reminderFields(reminderMin),
    };
  };

  /** Save sends the whole form, so a field the user left alone takes the
   *  stored event's current value: a sync pull, an undo or a note saved while
   *  the panel was open must not be reverted by an unrelated edit. */
  /** each field: whether the form still holds what the panel opened with
   *  (the form keeps times to the minute; an imported event's seconds
   *  stay as stored) */
  const untouched = () => {
    if (state.mode !== "view") return null;
    const input = buildInput();
    const opened = state.event;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const openedDates = eventDates(opened);
    const minute = (d: Date) => { const x = new Date(d); x.setSeconds(0, 0); return x; };
    const openedTimes = {
      start: opened.all_day ? toDateOnly(openedDates.start) : toLocalISO(minute(openedDates.start)),
      end: opened.all_day ? toDateOnly(openedDates.end) : toLocalISO(minute(openedDates.end)),
      all_day: opened.all_day,
    };
    const oRaw = opened.raw ?? {};
    const minutesOf = reminderOf;
    const emailsOf = (raw: any): string[] => (raw.attendees ?? []).map((a: any) => a.email).filter(Boolean);
    const parts = splitDrill(opened.description);
    return {
      input,
      times: same({ start: input.start, end: input.end, all_day: input.all_day }, openedTimes),
      title: title.trim() === opened.summary.trim(),
      body: description === htmlToText(parts.body),
      // (against the stored note: it saves on its own when typed, so after
      // a note edit Save wrote the event again, and asked a series' scope)
      note: drill === (liveDrill !== undefined ? liveDrill : cleanDrill(parts.drill, opened.summary)),
      location: location === (opened.location ?? ""),
      calendar: calendarId === opened.calendar_id,
      transparency: transparency === (oRaw.transparency ?? "opaque"),
      visibility: visibility === (oRaw.visibility ?? "default"),
      reminder: reminderMin === minutesOf(oRaw),
      guests: same(input.attendees ?? [], emailsOf(oRaw)),
      meet: !withMeet,
    };
  };

  const mergedInput = (): EventInput => {
    const u = untouched();
    const input = u?.input ?? buildInput();
    const live = props.liveEvent;
    if (state.mode !== "view" || !live || !u) return input;
    const merged = { ...input };
    if (u.times) {
      const d = eventDates(live);
      merged.start = live.all_day ? toDateOnly(d.start) : toLocalISO(d.start);
      merged.end = live.all_day ? toDateOnly(d.end) : toLocalISO(d.end);
      merged.all_day = live.all_day;
    }
    if (u.title) merged.summary = live.summary;
    if (u.body) {
      // the description as stored when neither its body nor the note was
      // touched (rebuilt, it moved the note and lost a trailing newline)
      merged.description = u.note ? live.description : joinDrill(splitDrill(live.description).body, drill) || null;
    }
    if (u.location) merged.location = live.location;
    // and the Google-resource fields
    const lRaw = live.raw ?? {};
    if (u.transparency) merged.transparency = lRaw.transparency ?? "opaque";
    if (u.visibility) merged.visibility = lRaw.visibility ?? "default";
    if (u.reminder) Object.assign(merged, reminderFields(reminderOf(lRaw)));
    const emailsOf = (raw: any): string[] => (raw.attendees ?? []).map((a: any) => a.email).filter(Boolean);
    if (u.guests) {
      const now = emailsOf(lRaw);
      merged.attendees = now.length > 0 ? now : [];
    }
    return merged;
  };

  const save = async () => {
    if (!props.backend || readOnly || savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (state.mode === "new") {
        await props.actions.create(buildInput());
        props.onClose();
      } else {
        // Nothing edited: nothing to write (a recurring one asked for a
        // scope, and "this and following" split the series over nothing)
        const u = untouched();
        if (u && u.times && u.title && u.body && u.note && u.location && u.calendar &&
            u.transparency && u.visibility && u.reminder && u.guests && u.meet) {
          props.onClose();
          return;
        }
        // the stored event, not the opened snapshot: undo restores from it
        const r = await props.actions.update(props.liveEvent ?? state.event, mergedInput());
        if (r !== "deferred") props.onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!props.backend || state.mode !== "view" || savingRef.current) return;
    savingRef.current = true; // (a double-click deleted twice: two undos, two copies)
    setBusy(true);
    try {
      const r = await props.actions.remove(props.liveEvent ?? state.event);
      if (r !== "deferred") props.onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      // the panel stays mounted between events: a busy flag left on here
      // disabled Save and Delete on every event opened after a delete
      savingRef.current = false;
      setBusy(false);
    }
  };

  const conference = state.mode === "view" ? state.event.conference_url : null;
  const cal = calendars.find((c) => c.id === calendarId);
  const calColor = cal ? colorOf(calendars, cal.id) : "#8a8a8a";
  const calendarChoices = calendars.filter((c) => calendarEditable(c) || c.id === calendarId);
  const isRecurring = state.mode === "view" && !!state.event.recurring_event_id;
  const tzName =
    Intl.DateTimeFormat().resolvedOptions().timeZone?.split("/").pop()?.replace("_", " ") ?? "local";
  // guests as Google has them (the stored event, fresher than the opened
  // snapshot: your own reply shows at once)
  const liveEv = state.mode === "view" ? (props.liveEvent ?? state.event) : null;
  const guestInfo = new Map<string, Guest>((liveEv ? guestsOf(liveEv) : []).map((g) => [g.email.toLowerCase(), g]));
  const rooms = new Set<string>(
    ((liveEv?.raw?.attendees ?? []) as any[]).filter((a) => a?.resource && a.email).map((a) => String(a.email).toLowerCase()),
  );
  const guestRows = attendees.filter((a) => !rooms.has(a.toLowerCase()));
  // organizer, you, then the rest; guests not saved yet last
  const order = (a: string) => {
    const g = guestInfo.get(a.toLowerCase());
    return g ? (g.organizer ? 0 : g.self ? 1 : 2) : 3;
  };
  guestRows.sort((a, b) => order(a) - order(b));
  const tally = rsvpTally(guestRows.map((a) => guestInfo.get(a.toLowerCase())).filter((g): g is Guest => !!g));
  // your answer to someone else's invitation (null: not an invitation)
  // (on a shared, read-only calendar the "self" guest is its owner, not you)
  const mine = liveEv && !readOnly ? myRsvp(liveEv) : null;
  const canEditGuests = !readOnly && mine === null;

  // (a multi-day all-day event shows its last day too: a Wed→Fri event read
  // "Wed, Oct 14" alone)
  const prettyDate = !date
    ? ""
    : allDay && allDayEnd && allDayEnd > date
      ? `${format(new Date(`${date}T00:00:00`), "EEE, MMM d")} – ${format(new Date(`${allDayEnd}T00:00:00`), "EEE, MMM d")}`
      : format(new Date(`${date}T00:00:00`), "EEE, MMM d");

  return (
    <aside
      className="event-panel"
      data-testid="event-panel"
      onKeyDown={(e) => {
        // an IME's Enter / Escape belong to the conversion (Enter saved and
        // closed a half-typed Japanese title)
        if (e.nativeEvent.isComposing || e.keyCode === 229) {
          e.stopPropagation();
          return;
        }
        // Escape with the ⋯ menu open closes the menu, not the editor
        if (e.key === "Escape" && menuOpen) {
          e.stopPropagation();
          setMenuOpen(false);
          return;
        }
        if (
          e.key === "Enter" &&
          (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName !== "TEXTAREA")
        ) {
          // (in the guests field Enter adds the guest; ⌘Enter saves)
          if ((e.target as HTMLElement).classList.contains("panel-attendee-input") && !(e.metaKey || e.ctrlKey)) return;
          // Enter on a focused button presses that button (All-day, Delete…)
          if (!(e.metaKey || e.ctrlKey) && (e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          save();
        }
      }}
    >
      <div className="panel-head">
        <span className="panel-kind">{state.mode === "new" ? "New event" : "Event"}</span>
        <span className="panel-head-actions">
          {state.mode === "view" && !readOnly && (
            <button
              className="panel-close"
              aria-label="More actions"
              onClick={() => setMenuOpen((o) => !o)}
            >
              ⋯
            </button>
          )}
          <button className="panel-close" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </span>
        {menuOpen && state.mode === "view" && (
          <div className="panel-menu" data-testid="panel-menu">
            <button
              onClick={() => {
                props.actions.duplicate(state.event);
                setMenuOpen(false);
              }}
            >
              Duplicate
            </button>
            {conference && (
              <button onClick={() => window.open(conference, "_blank")}>Join meeting</button>
            )}
            <button
              data-testid="panel-cancel"
              onClick={() => {
                toggleCanceled(props.liveEvent ?? state.event);
                setMenuOpen(false);
              }}
            >
              {isCanceled(props.liveEvent ?? state.event) ? "Restore event" : "Cancel event"}
            </button>
            <button className="ctx-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </div>

      <input
        className="panel-title"
        placeholder="Title"
        readOnly={readOnly}
        value={title}
        autoFocus={state.mode === "new"}
        onChange={(e) => setTitle(e.target.value)}
      />

      {state.mode === "view" && isCanceled(props.liveEvent ?? state.event) && (
        <div className="panel-canceled" data-testid="panel-canceled">
          <span>⊘ Canceled: kept on your calendar, struck through</span>
          <button className="set-link" onClick={() => toggleCanceled(props.liveEvent ?? state.event)}>Restore</button>
        </div>
      )}

      {readOnly && state.mode === "view" && (
        <div className="panel-readonly" data-testid="panel-readonly">
          <span>
            Read-only calendar{cal ? ` (${cal.summary})` : ""} — copy it into one of yours to make it your own
          </span>
          <span className="panel-copy">
            <button
              type="button"
              className="btn panel-copy-btn"
              data-testid="panel-copy"
              aria-expanded={copyOpen}
              onClick={() => setCopyOpen((o) => !o)}
            >
              Copy to my calendar…
            </button>
            {copyOpen && (
              <CopyTargets
                calendars={calendars}
                recurring={!!state.event.recurring_event_id}
                onPick={(id, series) => {
                  setCopyOpen(false);
                  void props.actions.copyTo(state.event, id, series);
                }}
              />
            )}
          </span>
        </div>
      )}

      {/* time */}
      <div className="panel-section">
        <span className="panel-icon">{Icon.clock}</span>
        <div className="panel-section-body">
          {!allDay ? (
            <div className="panel-times">
              <TimeField
                value={startTime}
                disabled={readOnly}
                testid="time-start"
                onPick={(v) => {
                  // Keep the actual elapsed duration when the event crosses
                  // midnight; subtracting clock values alone turns (for
                  // example) 11 PM–1 AM into a 15-minute same-clock span.
                  const currentStart = new Date(`${date}T${startTime}:00`);
                  const currentEnd = new Date(`${date}T${endTime}:00`);
                  currentEnd.setDate(currentEnd.getDate() + endDayOffset);
                  const currentDuration = currentEnd.getTime() - currentStart.getTime();
                  const durationMs = Math.max(
                    15 * 60000,
                    endDayOffset === 0 && currentDuration <= 0 ? 30 * 60000 : currentDuration,
                  );
                  const nextStart = new Date(`${date}T${v}:00`);
                  const nextEnd = new Date(nextStart.getTime() + durationMs);
                  setEndTime(format(nextEnd, "HH:mm"));
                  setEndDayOffset(calendarDayOffset(nextStart, nextEnd));
                  setStartTime(v);
                }}
              />
              <span className="panel-arrow">→</span>
              <TimeField
                value={endTime}
                disabled={readOnly}
                relativeTo={startTime}
                date={date}
                testid="time-end"
                onPick={(v, fromList) => {
                  setEndTime(v);
                  // an end at or before the start is the next day's: picked
                  // from the list (which runs on past midnight), already
                  // overnight, or typed when that makes it 12h or less (10 PM
                  // → a typed 12:30 AM saved as 10:30 PM); a longer typed
                  // span (7 PM → 5 PM) is a slip, and clamps on save as
                  // before. A typed end never drops a day it already had
                  // (7 PM → 7 AM +1d retyped as 7:30 AM was saved 7:30 PM)
                  // unless the event spanned a day or less (11 PM → 1 AM
                  // retyped 11:30 PM). The list runs the 24h after the start,
                  // so a pick says its day too, even on a 3-day event (a pick
                  // there kept "+2d" and saved 51h for a "3h" row)
                  const before = tMin(v) <= tMin(startTime);
                  if (fromList) {
                    setEndDayOffset(before ? 1 : 0);
                    return;
                  }
                  if (endDayOffset > 1) return;
                  if (before) {
                    if (endDayOffset === 1 || tMin(v) + 1440 - tMin(startTime) <= 720) setEndDayOffset(1);
                  } else if (tMin(endTime) + endDayOffset * 1440 - tMin(startTime) <= 1440) {
                    setEndDayOffset(0);
                  }
                }}
              />
              <span className="panel-dur">
                {endDayOffset > 0 && <span className="panel-nextday">+{endDayOffset}d</span>}
                {durationLabel(startTime, endTime, endDayOffset, date)}
              </span>
            </div>
          ) : (
            <div className="panel-times all-day-label">
              All day
              <input
                type="date"
                className="panel-date allday-end"
                value={allDayEnd && allDayEnd > date ? allDayEnd : date}
                min={date}
                disabled={readOnly}
                data-testid="allday-end"
                onChange={(e) => setAllDayEnd(e.target.value)}
                title="Last day"
              />
            </div>
          )}
          {dateEditing ? (
            <input
              ref={dateRef}
              type="date"
              className="panel-date"
              value={date}
              autoFocus
              disabled={readOnly}
              onChange={(e) => changeStartDate(e.target.value)}
              onBlur={() => setDateEditing(false)}
            />
          ) : (
            <button
              className="panel-date-pretty"
              disabled={readOnly}
              onClick={() => setDateEditing(true)}
            >
              {prettyDate}
            </button>
          )}
          <div className="panel-link-row">
            <button
              className={"panel-link" + (allDay ? " on" : "")}
              disabled={readOnly}
              onClick={() => toggleAllDay(!allDay)}
            >
              All-day
            </button>
            <span className="panel-link static" title="Events use your system time zone">
              {tzName}
            </span>
            {state.mode === "new" ? (
              <select
                className={"panel-link panel-repeat" + (repeatRule ? " on" : "")}
                value={repeatRule ?? ""}
                onChange={(e) => setRepeatRule(e.target.value || null)}
              >
                {REPEAT_PRESETS.map(([label, rule]) => (
                  <option key={label} value={rule ?? ""}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              isRecurring && <span className="panel-link on">Repeats</span>
            )}
          </div>
        </div>
      </div>

      {/* participants */}
      <div className="panel-section">
        <span className="panel-icon">{Icon.people}</span>
        <div className="panel-section-body">
          {guestRows.length > 0 && (
            <div className="panel-guests" data-testid="guests">
              <div className="panel-guests-head">
                <span className="panel-guests-count">
                  {guestRows.length} guest{guestRows.length === 1 ? "" : "s"}
                </span>
                {tally && <span className="panel-guests-tally" data-testid="guests-tally">{tally}</span>}
              </div>
              {guestRows.map((a) => {
                const g = guestInfo.get(a.toLowerCase());
                const rsvp = g?.rsvp ?? "new";
                const roles = [g?.organizer && "Organizer", g?.self && !readOnly && "You", g?.optional && "Optional"].filter(Boolean).join(" · ");
                const name = g?.name ?? a;
                return (
                  <div key={a} className={"panel-guest rsvp-" + rsvp} data-testid="guest-row" data-rsvp={rsvp} title={a}>
                    <span className="guest-avatar" style={{ "--guest-hue": hueOf(a) } as React.CSSProperties} aria-hidden="true">
                      {initialOf(name)}
                      {(rsvp === "accepted" || rsvp === "declined" || rsvp === "tentative") && (
                        <span className="guest-badge">{rsvp === "accepted" ? "✓" : rsvp === "declined" ? "✕" : "?"}</span>
                      )}
                    </span>
                    <span className="guest-text">
                      <span className="guest-name">{name}</span>
                      {(roles || (g?.name && a)) && (
                        <span className="guest-sub">{[roles, g?.name ? a : ""].filter(Boolean).join(" · ")}</span>
                      )}
                    </span>
                    <span className="sr-only">{GUEST_ANSWER[rsvp]}</span>
                    {canEditGuests && (
                      <button
                        className="guest-remove"
                        aria-label={`Remove ${a}`}
                        onClick={() => setAttendees((list) => list.filter((x) => x !== a))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {mine !== null && liveEv && (
            <div className="panel-rsvp" data-testid="rsvp">
              <span className="panel-rsvp-label">Going?</span>
              {(["accepted", "declined", "tentative"] as Rsvp[]).map((r) => (
                <button
                  key={r}
                  className={"rsvp-btn rsvp-btn-" + r + (mine === r ? " on" : "")}
                  aria-pressed={mine === r}
                  onClick={() => void props.actions.respond(liveEv, r).catch(() => {})}
                >
                  {RSVP_BUTTON[r]}
                </button>
              ))}
            </div>
          )}
          {canEditGuests && (
            <input
              className="panel-plain panel-attendee-input"
              placeholder="Add participants"
              value={attendeeInput}
              onChange={(e) => setAttendeeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addAttendee();
                }
              }}
              onBlur={addAttendee}
            />
          )}
          {!canEditGuests && guestRows.length === 0 && <span className="panel-muted">No guests</span>}
        </div>
      </div>

      {/* conferencing */}
      <div className="panel-section">
        <span className="panel-icon">{Icon.video}</span>
        <div className="panel-section-body">
          {conference ? (
            <a className="panel-join" href={conference} target="_blank" rel="noreferrer">
              Join meeting
            </a>
          ) : !readOnly ? (
            <label className="panel-meet">
              <input
                type="checkbox"
                checked={withMeet}
                onChange={(e) => setWithMeet(e.target.checked)}
              />
              Add Google Meet
            </label>
          ) : (
            <span className="panel-muted">No conferencing</span>
          )}
        </div>
      </div>

      {/* reconcile: did this actually happen? (ended events only) */}
      {state.mode === "view" &&
        !state.event.all_day &&
        eventDates(state.event).end.getTime() < now().getTime() &&
        !reconExempt(state.event, calendars) && (
          <div className="panel-section" data-testid="panel-recon">
            <span className="panel-icon">{Icon.review}</span>
            <div className="panel-section-body panel-recon-body">
              {(() => {
                const key = reconKey(state.event);
                const st = reconState(state.event, calendars, now());
                return (
                  <>
                    <span className="recon-q" id="recon-q">Did it happen?</span>
                    {/* one segmented control, like the app's others: the answer
                        is the selected segment ("Didn't happen" deletes, so it
                        never stays selected) */}
                    <div className="recon-seg" role="radiogroup" aria-labelledby="recon-q">
                      <button
                        role="radio"
                        aria-checked={st === "done"}
                        className={"recon-seg-btn yes" + (st === "done" ? " active" : "")}
                        data-testid="panel-recon-yes"
                        title={st === "done" ? "Marked as happened (click to undo)" : "It happened"}
                        onClick={() => setRecon(key, st === "done" ? null : "done")}
                      >
                        {st === "done" && Icon.tick}
                        Happened
                      </button>
                      <button
                        role="radio"
                        aria-checked={st === "canceled"}
                        className={"recon-seg-btn canceled" + (st === "canceled" ? " active" : "")}
                        data-testid="panel-recon-canceled"
                        title="Canceled: stays on the calendar, struck through"
                        onClick={() => setRecon(key, st === "canceled" ? null : "canceled", state.event)}
                      >
                        Canceled
                      </button>
                      <button
                        role="radio"
                        aria-checked={false}
                        className="recon-seg-btn no"
                        data-testid="panel-recon-no"
                        title="Didn't happen: removes the event (⌘Z undoes)"
                        onClick={() => void props.actions.removeOccurrence(state.event)}
                      >
                        Didn't happen
                      </button>
                    </div>
                    <button
                      className="recon-moved"
                      data-testid="panel-recon-move"
                      title="It happened, but at a different time: adjust the times and save"
                      onClick={(ev) => {
                        setRecon(key, "done");
                        const panel = (ev.currentTarget as HTMLElement).closest(
                          "[data-testid=event-panel]",
                        );
                        (panel?.querySelector("[data-testid=time-start]") as HTMLElement | null)?.focus();
                      }}
                    >
                      At a different time? <b>Adjust the times</b>
                    </button>
                  </>
                );
              })()}
            </div>
          </div>
        )}

      {/* location */}
      <div className="panel-section">
        <span className="panel-icon">{Icon.pin}</span>
        <div className="panel-section-body loc-body">
          <input
            className="panel-plain"
            placeholder="Location"
            value={location}
            readOnly={readOnly}
            onChange={(e) => {
              setLocation(e.target.value);
              setLocCoords(null);
            }}
            onKeyDown={(e) => {
              if (!locOpen) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                setLocActive((i) => Math.min(i + 1, locSuggestions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                e.stopPropagation();
                setLocActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                pickPlace(locSuggestions[locActive]);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setLocOpen(false);
              }
            }}
            onBlur={() => setTimeout(() => setLocOpen(false), 150)}
            data-testid="loc-input"
          />
          {locOpen && (
            <div className="loc-pop" data-testid="loc-pop">
              {locSuggestions.map((p, i) => (
                <button
                  key={p.label + i}
                  className={"loc-opt" + (i === locActive ? " active" : "")}
                  onMouseEnter={() => setLocActive(i)}
                  // pointerdown beats the input blur that closes the popover
                  onPointerDown={(e) => {
                    e.preventDefault();
                    pickPlace(p);
                  }}
                >
                  <span className="loc-name">{p.name}</span>
                  {p.detail && <span className="loc-detail">{p.detail}</span>}
                </button>
              ))}
            </div>
          )}
          {location.trim() && locCoords && (
            <div className="loc-preview" data-testid="loc-preview">
              <iframe
                title="map preview"
                src={osmEmbedUrl(locCoords.lat, locCoords.lon)}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
              <a
                className="loc-gmaps"
                href={gmapsUrl(location)}
                target="_blank"
                rel="noreferrer"
              >
                Open in Google Maps ↗
              </a>
            </div>
          )}
        </div>
      </div>

      {state.mode === "view" && !readOnly && (
        <div className="panel-section">
          <span className="panel-icon panel-star-icon">{Icon.star}</span>
          <div className="panel-section-body">
            <select
              className="panel-plain panel-goal"
              data-testid="goal-link"
              value={(() => {
                const st = starState(starKey(state.event));
                if (!st) return "";
                if (st.kind === "auto") return "__auto";
                // a deleted goal's events are still starred: say so (it read
                // "Not goal work" while the grid ringed them gold)
                return st.goal && goalOptions.includes(st.goal) ? st.goal : "__starred";
              })()}
              onChange={(e) => {
                const v = e.target.value;
                const key = starKey(state.event);
                if (v === "") setStarGoal(key, null);
                else if (v === "__starred") setStarGoal(key, "");
                else setStarGoal(key, v);
              }}
            >
              <option value="">Not goal work</option>
              <option value="__starred">Starred (no specific goal)</option>
              {starState(starKey(state.event))?.kind === "auto" && (
                <option value="__auto">
                  ☆ {starState(starKey(state.event))!.goal} (suggested — pick to confirm)
                </option>
              )}
              {goalOptions.map((g) => (
                <option key={g} value={g}>
                  ★ {g}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="panel-divider" />
      {/* (all-day events have no margin to show a note in) */}
      {state.mode === "view" && (!state.event.all_day || !!drill) && (
        <DrillNote
          key={`${state.event.calendar_id}/${state.event.id}`}
          note={drill}
          editable={!readOnly}
          ended={eventDates(state.event).end.getTime() < now().getTime()}
          onCommit={(n) => {
            setDrill(n);
            void props.actions.setNote(state.event, n).catch((cause) => {
              setDrill(liveDrillRef.current ?? null);
              setError(cause instanceof Error ? cause.message : String(cause));
            });
          }}
        />
      )}
      <GrowingTextarea
        className="panel-plain panel-desc"
        placeholder="Description"
        rows={7}
        value={description}
        readOnly={readOnly}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="panel-divider" />

      {/* calendar + busy/visibility */}
      <div className="panel-section">
        <span className="cal-dot panel-cal-dot" style={{ background: calColor }} />
        <div className="panel-section-body">
          <div className="panel-cal-picker" ref={calendarPickerRef}>
            <button
              type="button"
              className="panel-cal panel-cal-trigger"
              data-testid="panel-cal-trigger"
              disabled={readOnly}
              aria-haspopup="listbox"
              aria-expanded={calendarMenuOpen}
              onClick={() => setCalendarMenuOpen((open) => !open)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  e.stopPropagation();
                  setCalendarMenuOpen(true);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                }
              }}
            >
              <span>{cal?.summary ?? "Choose calendar"}</span>
              <svg className="panel-cal-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {calendarMenuOpen && (
              <div
                className="panel-cal-menu"
                role="listbox"
                aria-label="Calendar"
                data-testid="panel-cal-options"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setCalendarMenuOpen(false);
                    calendarPickerRef.current?.querySelector<HTMLButtonElement>(".panel-cal")?.focus();
                  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    e.stopPropagation();
                    const options = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".panel-cal-option")];
                    const index = options.indexOf(document.activeElement as HTMLButtonElement);
                    options[(index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
                  } else if (e.key === "Home" || e.key === "End") {
                    e.preventDefault();
                    e.stopPropagation();
                    const options = e.currentTarget.querySelectorAll<HTMLButtonElement>(".panel-cal-option");
                    options[e.key === "Home" ? 0 : options.length - 1]?.focus();
                  } else if (e.key === "Enter") {
                    e.stopPropagation();
                  }
                }}
              >
                {calendarChoices.map((c) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={c.id === calendarId}
                    className="panel-cal-option"
                    key={c.id}
                    onClick={() => {
                      setCalendarId(c.id);
                      setCalendarMenuOpen(false);
                    }}
                  >
                    <span className="cal-dot panel-cal-option-dot" style={{ background: colorOf(calendars, c.id) }} />
                    <span>{c.summary}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="panel-link-row">
            <select
              className="panel-link panel-inline-select"
              value={transparency}
              disabled={readOnly}
              onChange={(e) => setTransparency(e.target.value)}
            >
              <option value="opaque">Busy</option>
              <option value="transparent">Free</option>
            </select>
            <select
              className="panel-link panel-inline-select"
              value={visibility}
              disabled={readOnly}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value="default">Default visibility</option>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </div>
        </div>
      </div>

      {/* reminders */}
      <div className="panel-section">
        <span className="panel-icon">{Icon.bell}</span>
        <div className="panel-section-body">
          <select
            className="panel-cal"
            value={reminderMin == null ? "" : String(reminderMin)}
            disabled={readOnly}
            onChange={(e) => setReminderMin(e.target.value === "" ? null : Number(e.target.value))}
          >
            {REMINDER_CHOICES.map(([label, mins]) => (
              <option key={label} value={mins == null ? "" : String(mins)}>
                {label}
              </option>
            ))}
            {/* a reminder set elsewhere (15 min, 2 days…) shows as itself */}
            {reminderMin != null && !REMINDER_CHOICES.some(([, m]) => m === reminderMin) && (
              <option value={String(reminderMin)}>{reminderLabel(reminderMin)}</option>
            )}
          </select>
        </div>
      </div>

      {error && <div className="panel-error">{error}</div>}

      {!readOnly && (
      <div className="panel-footer">
        {state.mode === "view" && (
          <button className="btn btn-danger" onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <span className="panel-spacer" />
        <button className="btn btn-accent" onClick={save} disabled={busy}>
          {state.mode === "new" ? "Create" : "Save"} <kbd>↩</kbd>
        </button>
      </div>
      )}
    </aside>
  );
}

/** The red-pen note: your own line of reflection on the event, edited in
 *  place. It commits on its own (Enter or clicking away; Esc cancels),
 *  independent of the event form's Save, so closing the panel never loses
 *  it. One line: the note is stored as a single [DRILL] line. */
function DrillNote(props: {
  note: string | null;
  editable: boolean;
  ended: boolean;
  onCommit: (note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.note ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setText(props.note ?? "");
  }, [props.note, editing]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, editing]);
  useLayoutEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    // Focus before the newly-mounted field can receive input. A deferred RAF
    // here could steal a select-all/fill operation and move the caret back to
    // the end, turning a replacement into an accidental append under load.
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  const start = () => {
    if (!props.editable) return;
    cancelled.current = false;
    setEditing(true);
  };
  const commit = () => {
    const t = text.replace(/\s+/g, " ").trim();
    setEditing(false);
    if ((t || null) !== (props.note ?? null)) props.onCommit(t || null);
  };
  if (!props.note && !editing) {
    return props.editable && props.ended ? (
      <button className="drill-add" onClick={start} data-testid="drill-add">
        + Add a note
      </button>
    ) : null;
  }
  return (
    <div className={"panel-drill" + (editing ? " editing" : "")} data-testid="panel-drill">
      {editing ? (
        <textarea
          ref={ref}
          className="drill-input"
          rows={1}
          value={text}
          placeholder="Note to self…"
          aria-label="Note"
          data-testid="drill-input"
          onChange={(e) => setText(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelled.current = true;
              setText(props.note ?? "");
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (cancelled.current) {
              cancelled.current = false;
              return;
            }
            commit();
          }}
        />
      ) : (
        <button
          className="drill-text"
          onClick={start}
          disabled={!props.editable}
          title={props.editable ? "Edit note" : undefined}
          data-testid="drill-text"
        >
          {props.note}
        </button>
      )}
      {editing ? (
        <span className="drill-hint">↩ save · esc</span>
      ) : (
        props.editable && (
          <button
            className="drill-erase"
            title="Remove note (⌘Z to undo)"
            aria-label="Remove note"
            data-testid="drill-erase"
            onClick={() => props.onCommit(null)}
          >
            ✕
          </button>
        )
      )}
    </div>
  );
}
