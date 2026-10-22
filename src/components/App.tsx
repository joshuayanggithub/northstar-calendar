import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ProfilerOnRenderCallback,
} from "react";
import { flushSync } from "react-dom";
import {
  addDays,
  addMonths,
  addWeeks,
  eventDates,
  fmtChipRange,
  format,
  isoInZone,
  isSameDay,
  now,
  shiftWallClock,
  wallShiftBetween,
  startOfDay,
  toDateOnly,
  toLocalISO,
  wallIn,
  weekDays,
  zonedISO,
  type WallShift,
} from "../lib/dates";
import { useRef } from "react";
import {
  BackendContext,
  colorOf,
  useAuth,
  useBackendInit,
  useCalendars,
  useEvents,
  useVisibleEvents,
} from "../lib/useBackend";
import { calendarEditable, readOnlyEvent } from "../lib/types";
import { carryCopy, copiedKeys, linkCopy } from "../lib/copies";
import { currentEvent, thisHour } from "../lib/nudge";
import type { Calendar, CalendarEvent, EventInput } from "../lib/types";
import { RSVP_WORD, myRsvp, withMyRsvp, type Rsvp } from "../lib/rsvp";
import { ScopeDialog, type PendingScope, type Scope } from "./ScopeDialog";
import { aliasId, dismissToast, liveId, onToast, recordBarrier, recordUndo, showToast, undoLast } from "../lib/undo";
import { splitDrill } from "../lib/drill";
import { carryStar, markSeriesStarsDeleted, markStarDeleted, setAutoGoals } from "../lib/stars";
import { notePin, setNotePin } from "../lib/notePins";
import { RECON_WINDOW_MS, canceledSigs, carryRecon, isCanceled, reconKey, setRecon, setReconAll, subscribeRecon, unreconciled } from "../lib/recon";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { WeekView, type DraftEvent } from "./WeekView";
import { MonthView } from "./MonthView";
import { AgendaView } from "./AgendaView";
import { EventPanel, type PanelState } from "./EventPanel";
import { QuickCreate } from "./QuickCreate";
import { InsightsView } from "./InsightsView";
import { PANEL_PANE, PaneResize, SIDEBAR_PANE, usePaneWidth } from "./PaneResize";
import { CommandMenu } from "./CommandMenu";
import { SettingsDialog, type SettingsTab } from "./SettingsDialog";
import { HelpDialog, type HelpTab } from "./HelpDialog";
import { applyShade, applyTheme, getPrefs, setPrefs, usePrefs } from "../lib/settings";

export type View = "day" | "week" | "month" | "list" | "insights";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Optional development-only probe for dense horizontal-pan profiling. The
// production UI has no observer unless an E2E test installs the sink.
const profileCalendarRender: ProfilerOnRenderCallback = (id, _phase, actualDuration, _baseDuration, startTime, commitTime) => {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  const suffix = id === "WeekView" ? "weekView" : "calendarApp";
  const sink = (window as any)[`__${suffix}RenderDurations`];
  if (Array.isArray(sink)) sink.push(actualDuration);
  const marks = (window as any)[`__${suffix}RenderMarks`];
  if (Array.isArray(marks)) marks.push({ startTime, commitTime, actualDuration });
};

function addBusinessDays(day: Date, offset: number): Date {
  let result = addDays(startOfDay(day), Math.trunc(offset / 5) * 7);
  const direction = offset < 0 ? -1 : 1;
  for (let moved = 0; moved < Math.abs(offset % 5);) {
    result = addDays(result, direction);
    if (result.getDay() !== 0 && result.getDay() !== 6) moved++;
  }
  return result;
}

function businessDaysBetween(start: Date, end: Date): number {
  const calendarDays = Math.round((startOfDay(end).getTime() - startOfDay(start).getTime()) / 86_400_000);
  const direction = calendarDays < 0 ? -1 : 1;
  let result = 0;
  for (let i = 1; i <= Math.abs(calendarDays); i++) {
    const day = addDays(start, i * direction);
    if (day.getDay() !== 0 && day.getDay() !== 6) result += direction;
  }
  return result;
}

/** Snapshot an event as the input that would recreate/restore it. */
function inputOf(e: CalendarEvent): EventInput {
  return {
    calendar_id: e.calendar_id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    all_day: e.all_day,
  };
}

/** What a copy (⌘C, ⌘D, Copy) is made from: the event's own fields, without
 *  its red-pen note. A note is one occurrence's reflection; a duplicate
 *  carried it and a second note appeared in the margin. */
function copyInputOf(e: CalendarEvent): EventInput {
  return { ...inputOf(e), description: splitDrill(e.description).body || null };
}

/** Undoing a delete re-creates the event under a new id: older undo steps
 *  still name the old one ("event not found"). They resolve it here; and
 *  its review mark, star and placed note go with it. */
function aliasRestored(oldId: string, newId: string) {
  aliasId(oldId, newId);
  carryRecon(oldId, newId);
  carryStar(oldId, newId);
  carryCopy(oldId, newId);
  const pin = notePin(oldId);
  if (pin) setNotePin(newId, pin);
}

/** Full editable snapshot for undo. Copy/duplicate intentionally use inputOf
 * so they don't inherit attendees or private editor-only metadata. */
function undoInputOf(e: CalendarEvent): EventInput {
  const raw = e.raw ?? {};
  return {
    ...inputOf(e),
    // An omitted attendee list means "leave unchanged" to Google PATCH. For
    // Undo, no original guests must be an explicit empty list so newly added
    // guests are actually removed again.
    attendee_details: Array.isArray(raw.attendees) ? raw.attendees : [],
    reminders: raw.reminders ?? { useDefault: true },
    transparency: raw.transparency ?? "opaque",
    visibility: raw.visibility ?? "default",
  };
}

/** Undo of an edit: `prev` for the fields the edit changed, the current
 *  stored event for the rest. */
function undoOnto(cur: CalendarEvent, prev: EventInput, input: EventInput): EventInput {
  const out: EventInput = { ...undoInputOf(cur), calendar_id: prev.calendar_id };
  const o = out as unknown as Record<string, unknown>;
  const p = prev as unknown as Record<string, unknown>;
  const i = input as unknown as Record<string, unknown>;
  for (const k of ["summary", "description", "location", "start", "end", "all_day", "transparency", "visibility"]) {
    if (i[k] !== undefined && i[k] !== p[k]) o[k] = p[k];
  }
  if (input.reminder_minutes !== undefined || input.reminders !== undefined) out.reminders = prev.reminders;
  if (input.attendees !== undefined || input.attendee_details !== undefined) out.attendee_details = prev.attendee_details;
  return out;
}

/** What a deleted event is re-created from (undo) or a cut event pasted
 *  from: everything, its Meet/Zoom link too. */
function restoreInputOf(e: CalendarEvent): EventInput {
  // Someone else's invitation re-created as yours must not invite its
  // organizer and guests again, nor take their Meet room: its own fields
  // only (and your reminders / busy-free).
  const yours = !e.raw?.organizer || e.raw.organizer.self === true;
  if (!yours) {
    const full = undoInputOf(e);
    return { ...full, attendee_details: [], attendees: undefined };
  }
  // (Google's own conference resource only: one made up from a bare link,
  // a Zoom URL in the text, lacks a solution type and Google refuses the
  // whole event)
  return { ...undoInputOf(e), conference_data: e.raw?.conferenceData ?? undefined };
}

/** Google's id for a series' occurrence: the series id and the
 *  occurrence's original start (UTC basic format; a date for all-day). */
function firstInstanceId(seriesId: string, input: EventInput): string {
  if (input.all_day) return `${seriesId}_${input.start.slice(0, 10).replace(/-/g, "")}`;
  const iso = new Date(input.start).toISOString();
  return `${seriesId}_${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
}

const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** A series moved by `delta` days repeats on the moved days: BYDAY=WE moved
 *  a day later is BYDAY=TH (Google keeps generating Wednesdays otherwise,
 *  and the moved series snapped back on the next sync). Month days move too
 *  while they stay in 1..31. */
export function shiftRule(rule: string, delta: number, newDate?: string): string {
  const d = ((delta % 7) + 7) % 7;
  let out = rule;
  // a monthly "2nd Wednesday" moved a week later is the 3rd Wednesday: each
  // ordinal moves by the weeks of the month the moved occurrence moved
  // (1st and 3rd Mondays a day later are the 1st and 3rd Tuesdays; the
  // last one stays last)
  let weeks = 0;
  if (delta && newDate) {
    const to = Date.parse(`${newDate}T00:00:00Z`);
    const fromDay = new Date(to - delta * 86_400_000).getUTCDate();
    weeks = Math.ceil(Number(newDate.slice(8, 10)) / 7) - Math.ceil(fromDay / 7);
  }
  if (d || weeks) {
    out = out.replace(/BYDAY=([^;]+)/, (_, list: string) => "BYDAY=" + list.split(",").map((x) => {
      const m = x.match(/^([+-]?\d*)(SU|MO|TU|WE|TH|FR|SA)$/);
      if (!m) return x;
      const n = weeks && m[1] && !m[1].startsWith("-")
        ? String(Math.min(5, Math.max(1, Number(m[1]) + weeks)))
        : m[1];
      return n + RRULE_DAYS[(RRULE_DAYS.indexOf(m[2]) + d) % 7];
    }).join(","));
  }
  if (delta) {
    out = out.replace(/BYMONTHDAY=([^;]+)/, (whole, list: string) => {
      const days = list.split(",").map(Number);
      const moved = days.map((n) => n + delta);
      return days.every((n) => n > 0) && moved.every((n) => n >= 1 && n <= 31) ? `BYMONTHDAY=${moved.join(",")}` : whole;
    });
  }
  return out;
}

/** after a cut's first paste the clipboard is a copy: pasting it again
 *  mustn't put the meeting on every guest's calendar twice */
const leanCopy = (c: EventInput): EventInput => ({
  ...c,
  attendee_details: [],
  attendees: undefined,
  conference_data: undefined,
  // (and, as ⌘C and ⌘D, without the original's red-pen note)
  description: splitDrill(c.description).body || null,
});

/** Google replaces an attendee array supplied to PATCH. Avoid writing it when
 *  the editor hasn't changed it; if it did change, preserve each retained
 *  attendee resource (especially responseStatus) and default only new guests. */
function attendeeSafeUpdate(e: CalendarEvent, input: EventInput): EventInput {
  if (input.attendee_details !== undefined || input.attendees == null) return input;
  const prior = Array.isArray(e.raw?.attendees)
    ? e.raw.attendees as Array<Record<string, unknown>>
    : [];
  const priorEmails = prior
    .map((attendee) => typeof attendee.email === "string" ? attendee.email : "")
    .filter(Boolean);
  const normalize = (emails: string[]) => [...emails].map((email) => email.toLowerCase()).sort();
  const desiredEmails = normalize(input.attendees);
  const currentEmails = normalize(priorEmails);
  if (desiredEmails.length === currentEmails.length &&
      desiredEmails.every((email, index) => email === currentEmails[index])) {
    const unchanged = { ...input };
    delete unchanged.attendees;
    return unchanged;
  }
  const attendeesWithoutEmail = prior.filter((attendee) =>
    typeof attendee.email !== "string" || !attendee.email,
  );
  return {
    ...input,
    attendee_details: [
      ...attendeesWithoutEmail,
      ...input.attendees.map((email) => {
        const existing = prior.find((attendee) =>
          typeof attendee.email === "string" && attendee.email.toLowerCase() === email.toLowerCase(),
        );
        return existing ? { ...existing } : { email, responseStatus: "needsAction" };
      }),
    ],
  };
}

function reminderSafeUpdate(e: CalendarEvent, input: EventInput): EventInput {
  if (input.reminders !== undefined || input.reminder_minutes === undefined) return input;
  const raw = e.raw?.reminders as Record<string, any> | undefined;
  // (no reminders at all isn't the default: -1, as the editor's "No reminder")
  const previousMinutes = raw?.useDefault === false
    ? raw.overrides?.[0]?.minutes ?? -1
    : null;
  if (input.reminder_minutes !== previousMinutes) return input;

  // The editor exposes a single reminder choice, while Google resources may
  // contain several methods/overrides. An untouched selector must round-trip
  // the full resource instead of collapsing it to its first minutes value.
  const unchanged = { ...input, reminders: raw ?? { useDefault: true } };
  delete unchanged.reminder_minutes;
  return unchanged;
}

function eventMetadataSafeUpdate(e: CalendarEvent, input: EventInput): EventInput {
  return reminderSafeUpdate(e, attendeeSafeUpdate(e, input));
}

export interface EventActions {
  create(input: EventInput): Promise<string | null>;
  /** "deferred": a recurring event's scope dialog is open instead (the
   *  caller keeps its editor; the dialog's choice applies it) */
  update(ev: CalendarEvent, input: EventInput, label?: string): Promise<void | "deferred">;
  remove(ev: CalendarEvent): Promise<void | "deferred">;
  /** Delete just this event — for a recurring one, just this occurrence —
   *  without the scope prompt: reconciliation's "didn't happen". Undoable. */
  removeOccurrence(ev: CalendarEvent): Promise<void>;
  /** Delete the whole recurring series an instance belongs to. Not undoable. */
  removeSeries(ev: CalendarEvent): Promise<void>;
  /** Set (null clears) the red-pen note on just this event — for a
   *  recurring one, this occurrence — keeping the rest of its description.
   *  Undoable; never prompts for scope. */
  setNote(ev: CalendarEvent, note: string | null): Promise<void>;
  /** Reply to an invitation (a recurring one: this occurrence). Undoable. */
  respond(ev: CalendarEvent, status: Rsvp): Promise<void>;
  duplicate(ev: CalendarEvent): Promise<void>;
  /** Copy an event from one of the "Other calendars" into one of yours —
   *  with `series`, every occurrence of it — and open the copy. Undoable. */
  copyTo(ev: CalendarEvent, calendarId: string, series?: boolean): Promise<void>;
}

function openExternal(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.click();
}

export default function App() {
  // Production pan diagnostics install these sinks before input begins. React's
  // Profiler callback is intentionally development-only; measuring the app
  // shell here catches work around WeekView (for example, a day-window state
  // change) without clock reads or allocations during normal use.
  const hasAppRenderSink = typeof window !== "undefined" && (
    Array.isArray((window as any).__calendarAppRenderDurations) ||
    Array.isArray((window as any).__calendarAppRenderMarks)
  );
  const appRenderStartedAt = hasAppRenderSink ? performance.now() : null;
  useLayoutEffect(() => {
    if (appRenderStartedAt === null) return;
    const commitTime = performance.now();
    const duration = commitTime - appRenderStartedAt;
    const durations = (window as any).__calendarAppRenderDurations;
    if (Array.isArray(durations)) durations.push(duration);
    const marks = (window as any).__calendarAppRenderMarks;
    if (Array.isArray(marks)) marks.push({ startTime: appRenderStartedAt, commitTime, actualDuration: duration });
  });
  const backend = useBackendInit();
  const authed = useAuth(backend);
  const { calendars } = useCalendars(backend);
  // view, day count and hour zoom come back as left (a relaunch, e.g. after
  // an update, reset them to week / 1 day / 48px)
  const [view, setView] = useState<View>(() => {
    const v = stored("view");
    return v === "day" || v === "week" || v === "month" || v === "list" || v === "insights" ? v : "week";
  });
  const [anchor, setAnchor] = useState<Date>(() => now());
  const [panel, setPanel] = useState<PanelState>({ mode: "closed" });
  const [quickOpen, setQuickOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<CalendarEvent[]>([]);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarW, setSidebarW] = usePaneWidth(SIDEBAR_PANE);
  const [panelW, setPanelW] = usePaneWidth(PANEL_PANE);
  const [dayCount, setDayCount] = useState(() => {
    const n = Number(stored("day-count"));
    return Number.isInteger(n) && n >= 1 && n <= 9 ? n : 1;
  }); // 1-9 day view width (Notion 2-9)
  const [hourPx, setHourPx] = useState(() => {
    const n = Number(stored("hour-px"));
    return n >= 24 && n <= 120 ? n : 48;
  }); // hour zoom (shift+cmd+. / , / 0)
  useEffect(() => {
    try {
      localStorage.setItem("view", view);
      localStorage.setItem("day-count", String(dayCount));
      localStorage.setItem("hour-px", String(hourPx));
    } catch {
      /* private mode: for the session */
    }
  }, [view, dayCount, hourPx]);
  const [secondaryTz, setSecondaryTz] = useState<string | null>(() => {
    try {
      return localStorage.getItem("secondaryTz") || null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (secondaryTz) localStorage.setItem("secondaryTz", secondaryTz);
      else localStorage.removeItem("secondaryTz");
    } catch {
      /* private mode */
    }
  }, [secondaryTz]);
  const [hideWeekends, setHideWeekends] = useState<boolean>(() => {
    try {
      return localStorage.getItem("hideWeekends") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("hideWeekends", hideWeekends ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [hideWeekends]);
  const [panDays, setPanDays] = useState(0); // day-granular swipe offset (week view)
  const [seamStyle, setSeamStyle] = useState<"scarf" | "rabbet" | "overlay">(() => {
    try {
      const v = localStorage.getItem("overlapSeam");
      return v === "scarf" || v === "overlay" ? v : "rabbet";
    } catch {
      return "rabbet";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("overlapSeam", seamStyle);
    } catch {
      /* per-viewer convenience only */
    }
  }, [seamStyle]);
  const [toast, setToast] = useState<{ label: string; canUndo: boolean } | null>(null);
  const [pendingScope, setPendingScope] = useState<
    (PendingScope & { master?: any; masterP?: Promise<any> }) | null
  >(null);
  const [reconMode, setReconMode] = useState<{ queue: CalendarEvent[]; idx: number; skipped?: number } | null>(null);
  const [spotlight, setSpotlight] = useState(false);
  // Settings (⌘,) and Help (⌘/): app windows over everything
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [helpTab, setHelpTab] = useState<HelpTab | null>(null);
  const menuRef = useRef<(cmd: string) => void>(() => {});
  // the native menu bar's commands (and a hook for tests)
  useEffect(() => {
    (window as any).__menu = (cmd: string) => menuRef.current(cmd);
    if (!("__TAURI_INTERNALS__" in window)) return;
    let un: (() => void) | undefined;
    let gone = false;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("menu", (e) => menuRef.current(e.payload)).then((f) => (gone ? f() : (un = f))),
    );
    return () => {
      gone = true;
      un?.();
    };
  }, []);
  useEffect(() => {
    applyTheme();
    applyShade();
  }, []);
  // canceled events: the native alerts and menu bar skip them
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const send = () =>
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_canceled_events", { pairs: canceledSigs() }).catch(() => {}));
    send();
    return subscribeRecon(send);
  }, []);
  const [, reconTickApp] = useState(0);
  useEffect(() => subscribeRecon(() => reconTickApp((n) => n + 1)), []);
  // A new day while the app stays open (it lives in the tray for days):
  // re-render at local midnight and on coming back to the window, so the
  // sidebar's today, list view, the morning sweep and goal tallies roll over
  // (only the week grid had its own clock).
  const [, setDayTick] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const arm = () => {
      const t = now();
      const next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 1);
      timer = window.setTimeout(() => { setDayTick((n) => n + 1); arm(); }, Math.max(1000, next.getTime() - t.getTime()));
    };
    arm();
    const bump = () => setDayTick((n) => n + 1);
    const onVisible = () => { if (document.visibilityState === "visible") bump(); };
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  // the day the morning sweep was dismissed: it comes back the next morning
  // (the app stays open for days; a mount-time boolean kept it gone)
  const [sweepDismissedOn, setSweepDismissedOn] = useState<string | null>(() => {
    try {
      return localStorage.getItem("sweepDismissed");
    } catch {
      return toDateOnly(now());
    }
  });
  const sweepDismissed = sweepDismissedOn === toDateOnly(now());
  const clipboardRef = useRef<EventInput[] | null>(null);
  /** ids a ⌘X took from the calendar (null for a copy): a paste brings the
   *  guests and Meet room along only while that original is really gone. An
   *  undone cut, or a cancelled scope prompt, leaves it in place, and the
   *  paste is then a copy: re-inviting its guests sent them a duplicate. */
  const cutFromRef = useRef<(string | null)[] | null>(null);
  const hoveredRef = useRef<CalendarEvent | null>(null);

  useEffect(() => onToast(setToast), []);
  useEffect(() => setPanDays(0), [view]);
  useEffect(() => {
    document.body.classList.toggle("spotlight-goals", spotlight);
    return () => document.body.classList.remove("spotlight-goals");
  }, [spotlight]);

  // local classifier suggestions -> hollow stars (stars layer re-renders all)
  useEffect(() => {
    if (!backend) return;
    const pull = () => backend.getGoalClassifications().then(setAutoGoals).catch(() => {});
    pull();
    return backend.onGoalClassChanged(pull);
  }, [backend]);

  const range = useMemo((): { start: Date; end: Date; days: Date[] } => {
    if (view === "day") {
      const s = startOfDay(anchor);
      const days = Array.from({ length: dayCount }, (_, i) => addDays(s, i));
      return { start: s, end: addDays(s, dayCount), days };
    }
    if (view === "week") {
      const week = weekDays(anchor);
      const days = hideWeekends
        ? Array.from({ length: 5 }, (_, i) =>
            addBusinessDays(week.find((d) => d.getDay() !== 0 && d.getDay() !== 6)!, panDays + i))
        : week.map((d) => addDays(d, panDays));
      return { start: days[0], end: addDays(days[days.length - 1], 1), days };
    }
    if (view === "list") {
      const s = startOfDay(anchor);
      return { start: s, end: addDays(s, 14), days: [] };
    }
    if (view === "insights") {
      // back far enough for the prior 4 weeks (from today - 55d) and the
      // streak's lookback: the old week - 21d left most of the prior month
      // unfetched, so every 4-week delta read "up 300%"
      const today = startOfDay(now());
      return { start: addDays(today, -63), end: addDays(today, 8), days: [] };
    }
    const gridStart = weekDays(new Date(anchor.getFullYear(), anchor.getMonth(), 1))[0];
    return { start: gridStart, end: addDays(gridStart, 42), days: [] };
  }, [view, anchor, dayCount, hideWeekends, panDays]);

  // the day the sidebar's mini-month follows: a trackpad swipe moves only
  // panDays, so it stayed on the anchor's month while the grid showed the next
  const miniAnchorMs = panDays && range.days.length ? range.days[0].getTime() : anchor.getTime();
  // (a new anchor too, even on the same day: T brings a browsed mini-month back)
  const miniAnchor = useMemo(() => new Date(miniAnchorMs), [miniAnchorMs, anchor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch window: quantized to week blocks with two weeks of padding each
  // side (the week grid renders 14 days beyond each edge to swipe through),
  // so swiping never refetches until the view leaves the block —
  // refetch-per-pan was the main source of swipe jitter.
  const fetchStart = useMemo(() => {
    const s = weekDays(range.start)[0];
    return addDays(s, -14);
  }, [weekDays(range.start)[0].getTime()]); // eslint-disable-line react-hooks/exhaustive-deps
  const fetchEnd = useMemo(
    () => addDays(weekDays(range.end)[0], 21),
    // keyed on the week start itself: an epoch-week bucket (Thursday-based)
    // left fetchEnd up to 6 days stale, short of the runway's last days
    [weekDays(range.end)[0].getTime()], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const events = useEvents(backend, fetchStart, fetchEnd);
  // the stored events as of now, for undo steps that run later
  const eventsRef = useRef(events);
  eventsRef.current = events;
  // Isolate (right-click a calendar): only that calendar's events for now.
  // A view, not a setting: each calendar's own shown/hidden state, Google,
  // and reminders are untouched, and it ends with Show all / Escape / a
  // reload. A calendar that leaves the account ends it too.
  const [isolated, setIsolated] = useState<string | null>(null);
  useEffect(() => {
    if (isolated && calendars.length && !calendars.some((c) => c.id === isolated)) setIsolated(null);
  }, [isolated, calendars]);
  const viewCals = useMemo(
    () => (isolated ? calendars.map((c) => ({ ...c, hidden: c.id !== isolated })) : calendars),
    [calendars, isolated],
  );
  const shownCals = useVisibleEvents(events, viewCals);
  // an event copied in from someone else's calendar: the copy stands for it
  // (only copies you can see stand for their originals: hiding the calendar
  // holding a copy brings the original back, not hides both)
  const copied = useMemo(
    () => copiedKeys(
      events.filter((e) => !viewCals.find((c) => c.id === e.calendar_id)?.hidden),
      (e) => readOnlyEvent(e, calendars),
    ),
    [events, calendars, viewCals],
  );
  const prefs = usePrefs();
  const visible = useMemo(() => {
    const v = copied.size ? shownCals.filter((e) => !copied.has(`${e.calendar_id}/${e.id}`)) : shownCals;
    // Settings › General › Declined events
    return prefs.showDeclined ? v : v.filter((e) => myRsvp(e) !== "declined");
  }, [shownCals, copied, prefs.showDeclined]);

  // the selection follows its events: a move, an edit or a sync replaces the
  // event objects, and copy / duplicate / a second group drag must use the
  // current times, not the ones from when it was selected
  useEffect(() => {
    setSelected((sel) => {
      if (!sel.length) return sel;
      let changed = false;
      const next: CalendarEvent[] = [];
      for (const s of sel) {
        let cur = visible.find((e) => e.id === s.id && e.calendar_id === s.calendar_id);
        if (!cur) {
          // A calendar move changes the composite key but not the event id.
          // Follow it when there is exactly one visible candidate; if ids
          // collide across calendars, or this recurring occurrence now maps
          // to a different series, drop the stale selection instead.
          const sameId = visible.filter((e) => e.id === s.id);
          if (sameId.length === 1 &&
              (!s.recurring_event_id || sameId[0].recurring_event_id === s.recurring_event_id)) {
            cur = sameId[0];
          }
        }
        if (!cur) {
          // A remote delete (or a calendar being hidden) must not leave a
          // stale snapshot in the multi-selection. WeekView uses that list
          // to draw group-move ghosts and App later submits every selected
          // update; keeping a missing event here made one group drag partially
          // fail after the remaining events had already moved.
          changed = true;
          continue;
        }
        if (cur !== s) changed = true;
        next.push(cur);
      }
      return changed ? next : sel;
    });
  }, [visible]);

  /** Open the scope dialog for a recurring event at once and fetch its
   *  series master behind it. The fetch is a Google round trip; awaiting it
   *  before showing the dialog made every recurring edit feel stuck. */
  const askScope = useCallback(
    (p: PendingScope) => {
      if (!backend || !p.event.recurring_event_id) return;
      const masterP: Promise<any> = backend
        .getSeriesMaster(p.event.calendar_id, p.event.recurring_event_id)
        .catch(() => null); // fall back: only per-instance changes
      setPendingScope({ ...p, masterP });
      void masterP.then((master) => {
        const rrule = master?.recurrence?.some((r: string) => r.startsWith("RRULE"));
        setPendingScope((cur) =>
          cur?.masterP === masterP ? { ...cur, master, canSplit: cur.canSplit && !!rrule } : cur,
        );
      });
    },
    [backend],
  );

  // ---- actions with undo ----
  const calOf = useCallback(
    (id: string): Calendar | undefined => calendars.find((c) => c.id === id),
    [calendars],
  );
  const isReadOnly = useCallback(
    (ev: CalendarEvent) => !calendarEditable(calOf(ev.calendar_id)),
    [calOf],
  );

  /** Your answer to one event (or one occurrence): only your own
   *  responseStatus on its guest list changes (a guest can't edit the
   *  organizer's fields). Undoable. */
  const respondOne = useCallback(
    async (ev: CalendarEvent, status: Rsvp) => {
      if (!backend) return;
      let previous: string;
      try {
        previous = await backend.respondEvent(ev.calendar_id, ev.id, status);
      } catch (error) {
        showToast("Couldn't send your reply", false);
        throw error;
      }
      if (previous === status) return;
      recordUndo(`Replied ${RSVP_WORD[status]} to “${ev.summary}”`, async () => {
        await backend.respondEvent(ev.calendar_id, liveId(ev.id), previous);
      });
    },
    [backend],
  );

  const actions: EventActions = useMemo(
    () => ({
      async create(input) {
        if (!backend) return null;
        const id = await backend.createEvent(input);
        recordUndo(`Created “${input.summary}”`, async () => {
          await backend.deleteEvent(input.calendar_id, liveId(id));
          markStarDeleted(liveId(id)); // (a pasted cut's star counted on)
        });
        return id;
      },
      async update(ev, input, label) {
        if (!backend) return;
        if (isReadOnly(ev)) {
          showToast(`“${ev.summary}” is on a read-only calendar`, false);
          return;
        }
        if (ev.recurring_event_id) {
          // recurring: ask for scope before touching anything. The dialog
          // opens now; the series master (a Google round trip) loads behind
          // it and is awaited only when a scope is picked.
          askScope({ kind: "edit", event: ev, input, label, canSplit: true, noThis: input.calendar_id !== ev.calendar_id });
          return "deferred";
        }
        const prev = undoInputOf(ev);
        await backend.updateEvent(ev.id, eventMetadataSafeUpdate(ev, input), ev.calendar_id);
        recordUndo(label ?? `Updated “${ev.summary}”`, async () => {
          // restore what this edit changed (including a calendar move back),
          // over the event as it is now: a later remote edit to other fields
          // (a title, a note) survives undoing a drag
          const id = liveId(ev.id);
          const cur = eventsRef.current.find((e) => e.id === id && e.calendar_id === input.calendar_id);
          await backend.updateEvent(id, cur ? undoOnto(cur, prev, input) : prev, input.calendar_id);
        });
      },
      async remove(ev) {
        if (!backend) return;
        if (isReadOnly(ev)) {
          showToast(`“${ev.summary}” is on a read-only calendar`, false);
          return;
        }
        if (ev.recurring_event_id) {
          askScope({ kind: "delete", event: ev, canSplit: true });
          return "deferred";
        }
        const snapshot = restoreInputOf(ev);
        await backend.deleteEvent(ev.calendar_id, ev.id);
        markStarDeleted(ev.id);
        // close any panel showing it and drop selection
        setPanel((p) =>
          p.mode === "view" && p.event.id === ev.id && p.event.calendar_id === ev.calendar_id
            ? { mode: "closed" }
            : p,
        );
        setSelected((sel) => sel.filter((s) => !(s.id === ev.id && s.calendar_id === ev.calendar_id)));
        recordUndo(`Deleted “${ev.summary}”`, async () => {
          aliasRestored(ev.id, await backend.createEvent(snapshot));
        });
      },
      async removeOccurrence(ev) {
        if (!backend) return;
        if (isReadOnly(ev)) {
          showToast(`“${ev.summary}” is on a read-only calendar`, false);
          return;
        }
        const snapshot = restoreInputOf(ev);
        await backend.deleteEvent(ev.calendar_id, ev.id);
        markStarDeleted(ev.id);
        setPanel((p) =>
          p.mode === "view" && p.event.id === ev.id && p.event.calendar_id === ev.calendar_id
            ? { mode: "closed" }
            : p,
        );
        setSelected((sel) => sel.filter((s) => !(s.id === ev.id && s.calendar_id === ev.calendar_id)));
        recordUndo(`Didn't happen — deleted “${ev.summary}”`, async () => {
          if (ev.recurring_event_id) {
            await backend.restoreRecurringOccurrence(ev);
            markStarDeleted(ev.id, false); // (back under the same id)
          } else aliasRestored(ev.id, await backend.createEvent(snapshot));
        });
      },
      async setNote(ev, note) {
        if (!backend) return;
        if (isReadOnly(ev)) {
          showToast(`“${ev.summary}” is on a read-only calendar`, false);
          return;
        }
        // The backend rewrites only the note, on the description it has
        // stored. Building a whole EventInput from `ev` here wrote back
        // whatever snapshot the caller held: an editor opened before the
        // last note change re-added an erased note, or reverted the title.
        let previous: string | null;
        try {
          previous = await backend.setEventNote(ev.calendar_id, ev.id, note);
        } catch (error) {
          showToast(`Couldn't ${note ? "save" : "remove"} note`, false);
          throw error;
        }
        if ((previous ?? null) === (note ?? null)) return;
        recordUndo(note ? "Note saved" : "Note removed", async () => {
          await backend.setEventNote(ev.calendar_id, liveId(ev.id), previous);
        });
      },
      async respond(ev, status) {
        if (!backend) return;
        // a shared calendar's invitation is its owner's to answer
        if (isReadOnly(ev)) {
          showToast(`“${ev.summary}” is on a read-only calendar`, false);
          return;
        }
        // a recurring invitation: this one, or every occurrence (asked)
        if (ev.recurring_event_id) {
          askScope({ kind: "rsvp", event: ev, rsvp: status, canSplit: false });
          return;
        }
        await respondOne(ev, status);
      },
      async removeSeries(ev) {
        if (!backend || !ev.recurring_event_id) return;
        await backend.deleteEvent(ev.calendar_id, ev.recurring_event_id);
        markSeriesStarsDeleted(ev.recurring_event_id);
        setPanel((p) =>
          p.mode === "view" && p.event.recurring_event_id === ev.recurring_event_id
            ? { mode: "closed" }
            : p,
        );
        setSelected([]);
        recordBarrier(`Deleted series “${ev.summary}”`);
      },
      async duplicate(ev) {
        if (!backend) return;
        const input = copyInputOf(ev);
        // copying from a read-only calendar lands on the default calendar
        if (isReadOnly(ev)) {
          const target = calendars.find((c) => calendarEditable(c) && c.is_primary) ??
            calendars.find((c) => calendarEditable(c));
          if (!target) return;
          input.calendar_id = target.id;
        }
        const id = await backend.createEvent(input);
        recordUndo(`Duplicated “${ev.summary}”`, async () => {
          await backend.deleteEvent(input.calendar_id, liveId(id));
        });
      },
      async copyTo(ev, calendarId, series = false) {
        const cal = calOf(calendarId);
        if (!backend || !cal || !calendarEditable(cal)) return;
        // (the class's Meet/Zoom link comes along: the original steps aside)
        let input: EventInput = { ...inputOf(ev), calendar_id: calendarId, conference_data: ev.raw?.conferenceData ?? undefined };
        let whole = false;
        if (series && ev.recurring_event_id) {
          // the series as its owner wrote it: first occurrence + the rule
          const master = await backend.getSeriesMaster(ev.calendar_id, ev.recurring_event_id).catch(() => null);
          const rule = (master?.recurrence ?? []).filter((r: string) => /^(RRULE|EXRULE|RDATE|EXDATE)/.test(r));
          const s = master?.start?.dateTime ?? master?.start?.date;
          const e = master?.end?.dateTime ?? master?.end?.date;
          if (rule.length && s && e) {
            input = {
              ...input, summary: master.summary ?? ev.summary, start: s, end: e, all_day: !!master.start.date, recurrence: rule,
              // repeating in the series' own zone, not this computer's
              time_zone: master.start.timeZone ?? undefined,
              conference_data: master.conferenceData ?? input.conference_data,
            };
            whole = true;
          } else {
            showToast("Couldn't read the whole series — copied this event only", false);
          }
        }
        const id = await backend.createEvent(input);
        linkCopy(ev, { calendar_id: calendarId, id });
        recordUndo(`Copied “${ev.summary}”${whole ? " (every occurrence)" : ""} to ${cal.summary}`, async () => {
          await backend.deleteEvent(calendarId, liveId(id));
        });
        if (whole) return;
        // open the copy: it's yours now, to retitle, move or note
        const copy: CalendarEvent = {
          ...ev,
          ...input,
          id,
          etag: null,
          description: input.description ?? null,
          location: input.location ?? null,
          timezone: null,
          status: "confirmed",
          recurrence: null,
          recurring_event_id: null,
          conference_url: ev.conference_url,
          updated: null,
          raw: {},
        };
        setSelected([copy]);
        setPanel({ mode: "view", event: copy });
      },
    }),
    [backend, calendars, calOf, isReadOnly, askScope, respondOne],
  );

  /** the open event as currently stored (the panel's own copy is the
   *  snapshot it was opened with) */
  const panelLive = useMemo(
    () =>
      panel.mode === "view"
        ? events.find((e) => e.id === panel.event.id && e.calendar_id === panel.event.calendar_id) ?? null
        : null,
    [panel, events],
  );
  // Close only once the open event has been seen loaded and is then gone: a
  // just-created copy (Copy to my calendar) is opened before the refetch that
  // brings it in, and closing on that first miss shut its panel at once.
  const panelSeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (panel.mode !== "view") return;
    const key = `${panel.event.calendar_id}/${panel.event.id}`;
    if (panelLive) panelSeenRef.current = key;
    else if (panelSeenRef.current === key) {
      // A sync delete invalidates the editor's snapshot. Leaving it open lets
      // Save/Move target a deleted event and turns the external change into a
      // confusing failure. (Only while its days are fetched: stepping three
      // weeks away looked the same as a delete and dropped unsaved edits;
      // coming back, it has to be seen again before a miss means deleted.)
      const { start, end } = eventDates(panel.event);
      if (end > fetchStart && start < fetchEnd) setPanel({ mode: "closed" });
      else panelSeenRef.current = null;
    }
  }, [panel, panelLive, fetchStart, fetchEnd]);

  // ---- bulk operations over the multi-selection (per-instance semantics) ----
  const bulkRemove = useCallback(
    async (evs: CalendarEvent[]) => {
      if (!backend) return;
      if (evs.length === 1) {
        await actions.remove(evs[0]); // single: keeps read-only + scope dialog
        return;
      }
      const editable = evs.filter((e) => !isReadOnly(e));
      const skipped = evs.length - editable.length;
      if (editable.length === 0) {
        showToast("Selection is read-only", false);
        return;
      }
      const results = await Promise.allSettled(
        editable.map((e) => backend.deleteEvent(e.calendar_id, e.id)),
      );
      const deleted = editable.filter((_, index) => results[index].status === "fulfilled");
      for (const e of deleted) markStarDeleted(e.id);
      const failed = editable.length - deleted.length;
      const deletedKeys = new Set(deleted.map((e) => `${e.calendar_id}/${e.id}`));
      if (deleted.length === 0) {
        showToast(
          `Couldn't delete any of the ${editable.length} selected events` +
            (skipped ? ` (${skipped} read-only skipped)` : ""),
          false,
        );
        return;
      }
      const snapshots = deleted.map(restoreInputOf);
      setSelected((sel) => sel.filter((e) => !deletedKeys.has(`${e.calendar_id}/${e.id}`)));
      setPanel((p) =>
        p.mode === "view" && deletedKeys.has(`${p.event.calendar_id}/${p.event.id}`)
          ? { mode: "closed" }
          : p,
      );
      recordUndo(
        (failed
          ? `Deleted ${deleted.length} of ${editable.length} events; ${failed} failed`
          : `Deleted ${deleted.length} events`) +
          (skipped ? ` (${skipped} read-only skipped)` : ""),
        async () => {
          await Promise.all(deleted.map((event, index) =>
            event.recurring_event_id
              ? backend.restoreRecurringOccurrence(event).then(() => markStarDeleted(event.id, false))
              : backend.createEvent(snapshots[index]).then((id) => aliasRestored(event.id, id)),
          ));
        },
      );
    },
    [backend, actions, isReadOnly],
  );

  const bulkDuplicate = useCallback(
    async (evs: CalendarEvent[]) => {
      if (!backend) return;
      const ids: { cal: string; id: string }[] = [];
      let failed = 0;
      let skipped = 0;
      for (const ev of evs) {
        const input = copyInputOf(ev);
        if (isReadOnly(ev)) {
          const target =
            calendars.find((c) => calendarEditable(c) && c.is_primary) ??
            calendars.find((c) => calendarEditable(c));
          if (!target) {
            skipped++;
            continue;
          }
          input.calendar_id = target.id;
        }
        try {
          const id = await backend.createEvent(input);
          if (id) ids.push({ cal: input.calendar_id, id });
          else failed++;
        } catch {
          failed++;
        }
      }
      if (ids.length === 0) {
        showToast(
          `Couldn't duplicate any of the ${evs.length} selected events` +
            (skipped ? ` (${skipped} had no editable destination)` : ""),
          false,
        );
        return;
      }
      const attempted = evs.length - skipped;
      recordUndo(
        (failed
          ? `Duplicated ${ids.length} of ${attempted} events; ${failed} failed`
          : `Duplicated ${ids.length} events`) +
          (skipped ? ` (${skipped} had no editable destination)` : ""),
        async () => {
          await Promise.all(ids.map(({ cal, id }) => backend.deleteEvent(cal, liveId(id))));
        },
      );
    },
    [backend, calendars, isReadOnly],
  );

  /** Group drag: every selected timed, editable event moves by the dragged
   *  event's shift on the wall clock (whole days, then minutes), so each
   *  keeps its own time of day across a daylight-saving change. Recurring
   *  instances move as "this event" (no per-event dialogs in bulk). The
   *  selection stays, so the group can be dragged again. */
  const moveSelected = useCallback(
    async (shift: WallShift) => {
      if (!backend) return;
      const movable = selected.filter((e) => !isReadOnly(e) && !e.all_day);
      if (movable.length === 0) return;
      const prevs = movable.map((e) => [e, inputOf(e)] as const);
      const results = await Promise.allSettled(
        movable.map((e) => {
          const { start, end } = eventDates(e);
          // the end moves by the days the start moved (with weekends hidden
          // a business-day shift from Thu is +1 but from Fri is +3: an
          // overnight event shifted separately grew by a weekend)
          const newStart = shiftWallClock(start, shift);
          const input = {
            ...inputOf(e),
            start: toLocalISO(newStart),
            end: toLocalISO(shiftWallClock(end, wallShiftBetween(start, newStart))),
          };
          return backend.updateEvent(e.id, input, e.calendar_id);
        }),
      );
      const movedPrevs = prevs.filter((_, index) => results[index].status === "fulfilled");
      const failed = results.length - movedPrevs.length;
      const left = selected.length - movable.length;
      if (movedPrevs.length === 0) {
        showToast(`Couldn't move any of the ${movable.length} selected events`, false);
        return;
      }
      recordUndo(
        (failed
          ? `Moved ${movedPrevs.length} of ${movable.length} events; ${failed} failed`
          : `Moved ${movedPrevs.length} events`) +
          (left ? ` (${left} read-only or all-day stayed)` : ""),
        async () => {
          // only the times go back (as one event's move undo): the whole
          // snapshot took a title changed on Google meanwhile with it
          await Promise.all(movedPrevs.map(([e, prev]) => {
            const id = liveId(e.id);
            // yours, on its calendar (a colleague's read-only copy of the
            // same meeting shares the id: the undo moved that one back)
            const cur = eventsRef.current.find((x) => x.id === id && x.calendar_id === e.calendar_id)
              ?? eventsRef.current.find((x) => x.id === id && !isReadOnly(x));
            const input = cur ? { ...undoInputOf(cur), start: prev.start, end: prev.end } : prev;
            return backend.updateEvent(id, input, cur?.calendar_id ?? e.calendar_id);
          }));
        },
      );
    },
    [backend, selected, isReadOnly],
  );

  // resolve a scope choice for a pending recurring edit/delete
  const applyScope = useCallback(
    async (scope: Scope) => {
      const p = pendingScope;
      setPendingScope(null);
      if (!p || !backend) return;
      const ev = p.event;
      const masterId = ev.recurring_event_id!;
      // (a failed load is null: offline, or a transient error)
      const master = p.masterP ? await p.masterP.catch(() => null) : (p.master ?? null);
      const selectedOriginal = ev.raw?.originalStartTime?.dateTime ??
        ev.raw?.originalStartTime?.date ?? ev.start;
      const masterOriginal = master?.start?.dateTime ?? master?.start?.date;
      const firstOccurrence = !!masterOriginal &&
        (ev.all_day ? selectedOriginal === masterOriginal :
          Date.parse(selectedOriginal) === Date.parse(masterOriginal));
      const effectiveScope = scope === "following" && firstOccurrence ? "all" : scope;
      if (p.kind === "rsvp") {
        const status = p.rsvp ?? "accepted";
        if (scope === "this") {
          await respondOne(ev, status).catch(() => {});
          return;
        }
        // every occurrence: the series master's guest list with only your
        // answer changed (Google applies it to the whole series)
        const attendees = master ? withMyRsvp(master.attendees, status) : null;
        if (!attendees) {
          showToast(master ? "You aren't on this series' guest list" : "Couldn't load the series. No reply sent", false);
          return;
        }
        const before = master.attendees;
        try {
          await backend.updateSeriesMaster(ev.calendar_id, masterId, { attendees });
        } catch (e) {
          showToast(`Couldn't send your reply: ${e}`, false);
          return;
        }
        recordUndo(`Replied ${RSVP_WORD[status]} to every “${ev.summary}”`, async () => {
          await backend.updateSeriesMaster(ev.calendar_id, masterId, { attendees: before });
        });
        return;
      }
      // Every series change but deleting the whole series reads the master
      // (its rule, start, guests). Without it the change was dropped
      // silently, the editor already closed.
      if (!master && effectiveScope !== "this" && !(p.kind === "delete" && effectiveScope === "all")) {
        showToast("Couldn't load the series. Nothing was changed", false);
        return;
      }
      if (effectiveScope !== "this") {
        setPanel({ mode: "closed" });
        showToast("Saving series changes…", false);
      }
      const rrule: string | undefined = master?.recurrence?.find((r: string) =>
        r.startsWith("RRULE"),
      );
      const previousMasterStart: string | undefined = master?.start?.dateTime ?? master?.start?.date;
      const untilOf = (boundaryIso: string, allDay: boolean) => {
        if (allDay) {
          // RFC 5545 requires UNTIL to have the same value type as DTSTART.
          // Google represents all-day DTSTART as a date, so end the old
          // series on the calendar day before the selected occurrence.
          const u = new Date(`${boundaryIso.slice(0, 10)}T00:00:00Z`);
          u.setUTCDate(u.getUTCDate() - 1);
          const pad = (n: number) => String(n).padStart(2, "0");
          return `${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}`;
        }
        const u = new Date(new Date(boundaryIso).getTime() - 1000);
        const pad = (n: number) => String(n).padStart(2, "0");
        return (
          `${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}` +
          `T${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}${pad(u.getUTCSeconds())}Z`
        );
      };
      const truncateRule = (rule: string, boundaryIso: string, allDay: boolean) => {
        const until = `UNTIL=${untilOf(boundaryIso, allDay)}`;
        const withoutEnd = rule.replace(/;COUNT=\d+/, "").replace(/;UNTIL=[^;]+/, "");
        return `${withoutEnd};${until}`;
      };
      // The series' EXDATE/RDATE lines (deleted or added occurrences; Apple
      // and ICS series carry them). Google replaces the whole recurrence
      // list, so a split that sent only the RRULE brought deleted
      // occurrences back: each line goes with the half its dates fall in.
      // Each value is compared as the instant it names: a UTC value's date
      // prefix is a UTC date (an evening series' 9 PM is the next day in
      // UTC), a TZID value is wall time in its zone, a date is a whole day.
      const extrasBySide = (() => {
        const seriesTz: string = master?.start?.timeZone ?? ev.timezone ??
          Intl.DateTimeFormat().resolvedOptions().timeZone;
        const boundaryMs = Date.parse(selectedOriginal);
        const wallIn = (tz: string) => {
          const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
            timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
          }).formatToParts(new Date(boundaryMs)).map((x) => [x.type, x.value]));
          return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
        };
        const isBefore = (v: string, head: string) => {
          if (ev.all_day || !Number.isFinite(boundaryMs)) return v.slice(0, 8) < selectedOriginal.slice(0, 10).replace(/-/g, "");
          const z = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
          if (z) return Date.UTC(+z[1], +z[2] - 1, +z[3], +z[4], +z[5], +z[6]) < boundaryMs;
          let wall: string;
          try {
            wall = wallIn(head.match(/TZID=([^;:]+)/)?.[1] ?? seriesTz);
          } catch {
            wall = wallIn(seriesTz);
          }
          return v.length === 8 ? v < wall.slice(0, 8) : v < wall;
        };
        const before: string[] = [];
        const after: string[] = [];
        for (const line of (master?.recurrence ?? []) as string[]) {
          if (line.startsWith("RRULE")) continue;
          const i = line.lastIndexOf(":");
          const values = line.slice(i + 1).split(",");
          const head = line.slice(0, i);
          const pre = values.filter((v) => isBefore(v, head));
          const post = values.filter((v) => !isBefore(v, head));
          if (pre.length) before.push(`${line.slice(0, i)}:${pre.join(",")}`);
          if (post.length) after.push(`${line.slice(0, i)}:${post.join(",")}`);
        }
        return { before, after };
      })();
      try {
        if (p.kind === "delete") {
          if (effectiveScope === "this") {
            await backend.deleteEvent(ev.calendar_id, ev.id);
            markStarDeleted(ev.id);
            recordUndo(`Deleted “${ev.summary}”`, async () => {
              await backend.restoreRecurringOccurrence(ev);
              markStarDeleted(ev.id, false);
            });
          } else if (effectiveScope === "all") {
            await backend.deleteEvent(ev.calendar_id, masterId);
            markSeriesStarsDeleted(masterId);
            recordBarrier(`Deleted series “${ev.summary}”`);
          } else if (rrule) {
            await backend.updateSeriesMaster(ev.calendar_id, masterId, {
              recurrence: [truncateRule(rrule, selectedOriginal, ev.all_day), ...extrasBySide.before],
            });
            markSeriesStarsDeleted(masterId, ev.id);
            recordBarrier(`Deleted “${ev.summary}” and following`);
          }
          setSelected([]);
          setPanel({ mode: "closed" });
          return;
        }
        const input = p.input!;
        if (effectiveScope === "this") {
          const prev = undoInputOf(ev);
          await backend.updateEvent(ev.id, eventMetadataSafeUpdate(ev, input), ev.calendar_id);
          recordUndo(p.label ?? `Updated “${ev.summary}”`, async () => {
            // only what this edit changed: a later change (a sync's new
            // title) stays, as for a single event
            const cur = eventsRef.current.find((e) => e.id === ev.id && e.calendar_id === input.calendar_id);
            await backend.updateEvent(ev.id, cur ? undoOnto(cur, prev, input) : prev, input.calendar_id);
          });
        } else if (effectiveScope === "all") {
          // Only what the person changed goes to the whole series, and never
          // this occurrence's red-pen note: notes belong to one occurrence,
          // and sending the description as-is copied the note onto every
          // instance of the series.
          const patch: any = {};
          const bodyOf = (d: string | null | undefined) => splitDrill(d).body;
          if (input.summary !== ev.summary) patch.summary = input.summary;
          if ((input.location ?? null) !== (ev.location ?? null)) patch.location = input.location ?? null;
          if (bodyOf(input.description) !== bodyOf(ev.description)) {
            patch.description = bodyOf(input.description) || null;
          }
          if (input.transparency != null &&
              input.transparency !== (ev.raw?.transparency ?? "opaque")) {
            patch.transparency = input.transparency;
          }
          if (input.visibility != null &&
              input.visibility !== (ev.raw?.visibility ?? "default")) {
            patch.visibility = input.visibility;
          }
          // the editor's choice comes as reminder_minutes (Default: null, or
          // N minutes) or as a reminders resource ("No reminder": no
          // overrides, -1 here as in reminderSafeUpdate); the series had No
          // reminder when its overrides are empty, which isn't Default
          const chosenReminder = input.reminders !== undefined
            ? (input.reminders.useDefault === false
              ? (input.reminders.overrides as any[] | undefined)?.[0]?.minutes ?? -1 : null)
            : input.reminder_minutes;
          if (chosenReminder !== undefined) {
            const previousReminder = ev.raw?.reminders?.useDefault === false
              ? ev.raw.reminders.overrides?.[0]?.minutes ?? -1 : null;
            if (chosenReminder !== previousReminder) {
              patch.reminders = chosenReminder == null
                ? { useDefault: true }
                : chosenReminder === -1
                  ? { useDefault: false, overrides: [] }
                  : { useDefault: false, overrides: [{ method: "popup", minutes: chosenReminder }] };
            }
          }
          if (input.with_meet) {
            patch.conferenceData = {
              createRequest: {
                requestId: crypto.randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            };
          }
          if (input.attendees) {
            const instanceAttendees = Array.isArray(ev.raw?.attendees)
              ? ev.raw.attendees as Array<Record<string, unknown>>
              : [];
            const seriesAttendees = Array.isArray(master?.attendees)
              ? master.attendees as Array<Record<string, unknown>>
              : instanceAttendees;
            const emailOf = (attendee: Record<string, unknown>) =>
              typeof attendee.email === "string" && attendee.email ? attendee.email : null;
            const normalizeEmails = (values: string[]) =>
              [...values].map((email) => email.toLowerCase()).sort().join("\n");
            const instanceEmails = instanceAttendees
              .map(emailOf).filter((email): email is string => email !== null);
            const seriesEmails = seriesAttendees
              .map(emailOf).filter((email): email is string => email !== null);
            if (normalizeEmails(input.attendees) !== normalizeEmails(instanceEmails)) {
              // Apply only the user's attendee-list delta from this exception
              // to the series master. Replacing the master from the exception's
              // full list drops master-only guests whenever the two differ.
              const before = new Set(instanceEmails.map((email) => email.toLowerCase()));
              const desired = new Set(input.attendees.map((email) => email.toLowerCase()));
              const removed = new Set([...before].filter((email) => !desired.has(email)));
              const seriesSet = new Set(seriesEmails.map((email) => email.toLowerCase()));
              // The editor only displays attendees with an email. Keep API
              // attendee rows it cannot represent. A recurring-master patch
              // must preserve the master attendee's RSVP, not copy a possibly
              // different response from the selected exception instance.
              patch.attendees = [
                ...seriesAttendees.filter((attendee) => {
                  const email = emailOf(attendee);
                  return email === null || !removed.has(email.toLowerCase());
                }),
                ...input.attendees
                  .filter((email) => !before.has(email.toLowerCase()) && !seriesSet.has(email.toLowerCase()))
                  .map((email) => ({ email, responseStatus: "needsAction" })),
              ];
            }
          }
          const timesChanged = input.all_day !== ev.all_day ||
            (input.all_day
              ? input.start !== ev.start || input.end !== ev.end
              : new Date(input.start).getTime() !== new Date(ev.start).getTime() ||
                new Date(input.end).getTime() !== new Date(ev.end).getTime());
          const masterStart = master?.start?.dateTime;
          const masterStartDate = master?.start?.date;
          // dates and times in the series' own zone (it repeats there), and
          // the shift measured from this occurrence's own slot (a moved one's
          // original day: from the moved day, the series went to Tuesdays)
          const tz: string = master?.start?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
          const masterDate = masterStartDate ?? (masterStart ? wallIn(new Date(masterStart), tz).date : null);
          if (timesChanged && masterDate) {
            const slot = ev.raw?.originalStartTime;
            const newSelectedDate = input.all_day ? input.start : wallIn(new Date(input.start), tz).date;
            // (only a change of day is measured from the slot: a moved
            // occurrence given a new time or length keeps the series' days)
            const curDate = ev.all_day ? ev.start : wallIn(new Date(ev.start), tz).date;
            const selectedDate = newSelectedDate === curDate
              ? newSelectedDate
              : ev.all_day
                ? (slot?.date ?? ev.start)
                : wallIn(new Date(slot?.dateTime ?? ev.start), tz).date;
            const dayDelta = Math.round((Date.parse(`${newSelectedDate}T00:00:00Z`) -
              Date.parse(`${selectedDate}T00:00:00Z`)) / 86_400_000);
            const newMasterDate = toDateOnly(addDays(new Date(`${masterDate}T00:00:00`), dayDelta));
            // (the ordinal from the occurrence that was moved: the master's
            // shifted date can sit in another week of its month)
            const shifted = rrule ? shiftRule(rrule, dayDelta, newSelectedDate) : rrule;
            if (rrule && shifted !== rrule) {
              patch.recurrence = ((master?.recurrence ?? [rrule]) as string[])
                .map((line) => (line.startsWith("RRULE") ? shifted : line));
            }
            if (input.all_day) {
              const durationDays = Math.max(1, Math.round((Date.parse(`${input.end}T00:00:00Z`) -
                Date.parse(`${input.start}T00:00:00Z`)) / 86_400_000));
              patch.start = { date: newMasterDate, dateTime: null, timeZone: null };
              patch.end = { date: toDateOnly(addDays(new Date(`${newMasterDate}T00:00:00`), durationDays)),
                dateTime: null, timeZone: null };
            } else {
              const t = new Date(input.start);
              const dur = new Date(input.end).getTime() - t.getTime();
              const w = wallIn(t, tz);
              const startISO = zonedISO(newMasterDate, w.h, w.m, w.s, tz);
              patch.start = { dateTime: startISO, timeZone: tz, date: null };
              patch.end = { dateTime: isoInZone(new Date(new Date(startISO).getTime() + dur), tz), timeZone: tz, date: null };
            }
          }
          // patch + calendar move as one backend step (a sync pass between
          // them showed the series gone from both calendars)
          await backend.updateSeriesMaster(
            ev.calendar_id,
            masterId,
            patch,
            input.calendar_id !== ev.calendar_id ? input.calendar_id : undefined,
            previousMasterStart,
          );
          recordBarrier(`Updated all “${ev.summary}” events`);
        } else if (rrule) {
          // split: truncate the old series, start a new one at this instance
          // (on the days it was moved to)
          // (in the series' zone, from this occurrence's own slot: as above)
          const tzF: string = master?.start?.timeZone ?? ev.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
          const slotF = ev.raw?.originalStartTime;
          const toDate = input.all_day ? input.start.slice(0, 10) : wallIn(new Date(input.start), tzF).date;
          const curF = ev.all_day ? ev.start.slice(0, 10) : wallIn(new Date(ev.start), tzF).date;
          const slotDate = ev.all_day
            ? (slotF?.date ?? ev.start).slice(0, 10)
            : wallIn(new Date(slotF?.dateTime ?? ev.start), tzF).date;
          const fromDate = toDate === curF ? toDate : slotDate;
          const nextRule = shiftRule(rrule, Math.round(
            (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000), toDate);
          // A moved occurrence kept on its moved day starts the new series
          // there (Google counts the start as the first occurrence) and the
          // series' own days go on after it; its empty slot, when it falls
          // on or after that start, would come back as a regular
          // occurrence (a Wednesday moved to Tuesday had both days).
          // (at the new series' time of day: an EXDATE names an instance
          // exactly, and the slot's old time excluded nothing when the time
          // changed too)
          const slotAtNewTime = () => {
            const w = wallIn(new Date(input.start), tzF);
            return new Date(zonedISO(slotDate, w.h, w.m, w.s, tzF)).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
          };
          const slotExcluded = toDate === curF && slotDate !== toDate && slotDate >= toDate
            ? [ev.all_day ? `EXDATE;VALUE=DATE:${slotDate.replace(/-/g, "")}` : `EXDATE:${slotAtNewTime()}`]
            : [];
          const count = Number(rrule.match(/(?:^|;)COUNT=(\d+)/)?.[1] ?? 0);
          const countSplit = count ? {
            // (recounted from the moved rule: only COUNT changes)
            originalRecurrence: nextRule,
            selectedOriginalStart: ev.raw?.originalStartTime ??
              (ev.all_day ? { date: ev.start } : { dateTime: ev.start }),
          } : undefined;
          // truncate + new series as one backend step: done as two calls,
          // a sync pass between them pulled the old series' cancelled tail
          // before the new series existed, and the rest of the series
          // vanished from view until the next pass.
          // The new half starts as the series was (guests with their RSVPs,
          // reminders, busy/free, visibility) with the user's changes on top:
          // a drag sends only times and title, and the old half no longer
          // covers these dates, so anything not carried over was lost.
          const changes = Object.fromEntries(
            Object.entries(eventMetadataSafeUpdate(ev, input)).filter(([, v]) => v !== undefined),
          ) as Partial<EventInput>;
          const base = undoInputOf(ev);
          if (changes.reminder_minutes !== undefined) delete base.reminders;
          const splitInput = { ...base, ...changes } as EventInput;
          // this occurrence's red-pen note stays on it (not on the whole
          // new series), and so does its review mark: the old row goes with
          // the truncated tail and the new series has new ids
          const firstNote = splitDrill(input.description).drill;
          const newId = await backend.splitSeries(ev.calendar_id, masterId, [truncateRule(rrule, selectedOriginal, ev.all_day), ...extrasBySide.before], {
            ...splitInput,
            // repeat in the series' zone, not this computer's
            time_zone: master?.start?.timeZone ?? ev.timezone ?? undefined,
            // and its Meet/Zoom link
            conference_data: master?.conferenceData ?? ev.raw?.conferenceData ?? undefined,
            description: splitDrill(input.description).body || null,
            recurrence: [nextRule, ...slotExcluded, ...extrasBySide.after],
          }, countSplit, firstNote);
          // until the pull expands it the new series shows as one row under
          // its own id; then as Google's first occurrence
          carryRecon(ev.id, newId);
          carryRecon(ev.id, firstInstanceId(newId, input));
          carryStar(ev.id, newId);
          carryStar(ev.id, firstInstanceId(newId, input));
          // and where its note was placed by hand
          const pin = notePin(ev.id);
          if (pin) {
            setNotePin(newId, pin);
            setNotePin(firstInstanceId(newId, input), pin);
          }
          recordBarrier(`Updated “${input.summary}” and following`);
        }
        setPanel({ mode: "closed" });
      } catch (e) {
        showToast(`Series update failed: ${e}`, false);
      }
    },
    [pendingScope, backend, respondOne],
  );

  const pan = useCallback(
    (deltaDays: number) => {
      if (view === "week") {
        // A native scroll can paint between the wheel/scroll event and React's
        // deferred commit. Rebase the rendered days and scroll offset together.
        flushSync(() => setPanDays((p) => p + deltaDays));
      } else {
        setAnchor((prev) => addDays(prev, deltaDays));
      }
    },
    [view],
  );

  // stable, so the memoized sidebar skips the re-render on every swipe step
  const pickDate = useCallback(
    (d: Date) => {
      setPanDays(0);
      setAnchor(d);
      if (view === "month" || view === "insights") setView("week");
    },
    [view],
  );

  const toggleWeekends = useCallback(() => {
    if (view === "week") {
      const week = weekDays(anchor);
      if (hideWeekends) {
        // (a week never swiped comes back as Sun–Sat: its Monday read as
        // an offset of one, and j then stepped Mon–Sun weeks)
        setPanDays(panDays === 0 ? 0 : Math.round((range.days[0].getTime() - week[0].getTime()) / 86_400_000));
      } else {
        const firstWeekday = range.days.find((d) => d.getDay() !== 0 && d.getDay() !== 6)!;
        const baseWeekday = week.find((d) => d.getDay() !== 0 && d.getDay() !== 6)!;
        setPanDays(businessDaysBetween(baseWeekday, firstWeekday));
      }
    }
    setHideWeekends(!hideWeekends);
  }, [anchor, hideWeekends, range.days, view, panDays]);

  const enterReconMode = useCallback(
    (queue: CalendarEvent[]) => {
      if (queue.length === 0) {
        showToast("Nothing to review — all caught up", false);
        return;
      }
      setReconMode({ queue, idx: 0 });
      setSelected([queue[0]]);
    },
    [],
  );

  const reconModeRef = useRef(reconMode);
  reconModeRef.current = reconMode;
  const reconAdvance = useCallback(
    (action: "done" | "canceled" | "deleted" | "skip" | "open" | "exit") => {
      const m = reconModeRef.current;
      if (!m) return;
      const target = m.queue[m.idx];
      if (action === "exit") {
        setSelected([]);
        setReconMode(null);
        return;
      }
      if (action === "open") {
        setPanel({ mode: "view", event: target });
        setSelected([]);
        setReconMode(null);
        return;
      }
      if (action === "done") setRecon(reconKey(target), "done");
      if (action === "canceled") setRecon(reconKey(target), "canceled", target);
      if (action === "deleted") void actions.removeOccurrence(target);
      const idx = m.idx + 1;
      const skipped = (m.skipped ?? 0) + (action === "skip" ? 1 : 0);
      if (idx >= m.queue.length) {
        // "squared away" only when nothing was left unanswered
        showToast(
          skipped
            ? `${skipped} event${skipped === 1 ? "" : "s"} left to review`
            : "All reviewed — day squared away",
          false,
        );
        setSelected([]);
        setReconMode(null);
        return;
      }
      setSelected([m.queue[idx]]);
      setReconMode({ ...m, idx, skipped });
    },
    [actions],
  );

  // leaving a swiped week: the next view starts from the days shown (the
  // view change resets the swipe offset, so the anchor takes it over)
  const changeView = useCallback(
    (v: typeof view) => {
      if (v !== view && view === "week" && panDays && range.days.length) setAnchor(range.days[0]);
      // month and list show no selection: a kept one took Backspace blind
      if (v !== "week" && v !== "day") setSelected([]);
      setView(v);
    },
    [view, panDays, range],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      // A week swiped by N days steps on from the days shown (keep the
      // swipe's offset); it stepped from the pre-swipe week.
      if (view === "insights") return; // (nothing to page; the title moved)
      if (view !== "week") setPanDays(0);
      setAnchor((a) => {
        if (view === "day") return addDays(a, dir * dayCount);
        if (view === "week") return addWeeks(a, dir);
        if (view === "list") return addWeeks(a, dir * 2);
        // paging months keeps the day you started from: Jan 31 → Feb 28 →
        // back to Jan 28 lost today; the month after a short one clamps to
        // its end and the next unclamps
        const want = monthDayRef.current?.from === a.getTime() ? monthDayRef.current.day : a.getDate();
        const n = addMonths(a, dir);
        n.setDate(Math.min(want, new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate()));
        monthDayRef.current = { from: n.getTime(), day: want };
        return n;
      });
    },
    [view, dayCount],
  );

  const monthDayRef = useRef<{ from: number; day: number } | null>(null);
  const keyOfEv = (e: { calendar_id: string; id: string }) => `${e.calendar_id}/${e.id}`;
  const selectedOne = selected.length === 1 ? selected[0] : null;

  const openEvent = useCallback(
    (e: CalendarEvent, anchorPos?: { x: number; y: number }) => {
      setSelected([e]);
      setPanel({ mode: "view", event: e, anchor: anchorPos });
    },
    [],
  );

  const toggleSelect = useCallback((e: CalendarEvent) => {
    setSelected((sel) =>
      sel.some((s) => keyOfEv(s) === keyOfEv(e))
        ? sel.filter((s) => keyOfEv(s) !== keyOfEv(e))
        : [...sel, e],
    );
  }, []);
  const openDraft = useCallback(
    (d: DraftEvent, anchorPos?: { x: number; y: number }) =>
      setPanel({ mode: "new", draft: d, anchor: anchorPos }),
    [],
  );
  // (the recurring-scope dialog too: shortcuts ran behind it)
  const anyOverlay = panel.mode !== "closed" || quickOpen || cmdOpen || !!pendingScope;

  // the events on screen: ⌘A, n/b act on these, never on the weeks around
  // the view that are only fetched (⌘A then Delete deleted unseen events)
  const sortedVisible = useMemo(
    () =>
      visible
        .filter((e) => {
          const { start, end } = eventDates(e);
          if (!(end > range.start && start < range.end)) return false;
          // the days drawn, not the span they cover: weekends hidden and
          // swiped (Wed–Tue), the hidden Saturday was in ⌘A and n/b
          return !range.days.length || range.days.some((d) => end > d && start < addDays(d, 1));
        })
        .sort((a, b) => eventDates(a).start.getTime() - eventDates(b).start.getTime()),
    [visible, range.start, range.end, range.days],
  );

  const clipboardOp = useCallback(
    (ev: CalendarEvent, cut: boolean) => {
      // a cut is a move, as ⌘X: everything comes along (a copy is lean)
      clipboardRef.current = [cut && !isReadOnly(ev) ? restoreInputOf(ev) : copyInputOf(ev)];
      cutFromRef.current = cut ? [`${ev.calendar_id}/${ev.id}`] : null;
      if (cut) {
        bulkRemove([ev]);
      } else {
        showToast(`Copied “${ev.summary}”`, false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bulkRemove, isReadOnly],
  );

  const cycleSelection = useCallback(
    (dir: 1 | -1) => {
      if (sortedVisible.length === 0 || (view !== "week" && view !== "day")) return;
      const cur = selected[selected.length - 1] ?? null;
      const idx = cur
        ? sortedVisible.findIndex((e) => e.id === cur.id && e.calendar_id === cur.calendar_id)
        : -1;
      // with nothing selected, n starts at the first event and b at the last
      const next = idx === -1
        ? sortedVisible[dir === 1 ? 0 : sortedVisible.length - 1]
        : sortedVisible[(idx + dir + sortedVisible.length) % sortedVisible.length];
      setSelected([next]);
    },
    [selected, sortedVisible],
  );

  // clicking anywhere that isn't a chip or an overlay clears the selection
  // (Notion: clicking the chrome/sidebar deselects; Escape is not the only out)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (
        t.closest(
          ".chip, .mchip, .list-row, .event-panel, .scope-dialog, .ctx-menu, .toast, .cmdk, .quick-create",
        )
      )
        return;
      setSelected((sel) => (sel.length ? [] : sel));
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, []);

  // Join (⌘J, Go › Join Next Meeting): the selected event's link, else
  // today's next meeting with one, as the menu bar lists them: from the
  // store (the view's fetch is a few weeks around the grid: weeks ahead it
  // joined a meeting in November; weeks back it found none), not hidden,
  // declined, canceled here, all-day, or an original you copied
  const joinNext = async () => {
    const t = now();
    if (selectedOne?.conference_url) return openExternal(selectedOne.conference_url);
    const pool = backend
      ? await backend.listEvents(new Date(t.getTime() - 12 * 3600000).toISOString(), addDays(t, 7).toISOString())
      : visible;
    const shown = (e: CalendarEvent) => !viewCals.find((c) => c.id === e.calendar_id)?.hidden;
    // (a copy on a hidden calendar isn't shown, so its original is)
    const copiedNow = copiedKeys(pool.filter(shown), (e) => readOnlyEvent(e, calendars));
    const next = pool
      .filter((e) => e.conference_url && !e.all_day && eventDates(e).end.getTime() >= t.getTime())
      .filter(shown)
      .filter((e) => !copiedNow.has(`${e.calendar_id}/${e.id}`) && myRsvp(e) !== "declined" && !isCanceled(e))
      .sort((a, b) => eventDates(a).start.getTime() - eventDates(b).start.getTime())[0];
    if (next?.conference_url) openExternal(next.conference_url);
    else showToast("No upcoming meeting with a link", false);
  };

  // Review (R, Go › Review Recent Events): the queue is the last review
  // window, wherever the view is: go to today and read those days (the
  // view's fetch may not reach them: from a later week "r" said all caught up)
  const startReview = () => {
    const t = now();
    setPanDays(0);
    setAnchor(t);
    if (view !== "week" && view !== "day") setView("week");
    if (backend) {
      void backend
        .listEvents(new Date(t.getTime() - RECON_WINDOW_MS - 86400000).toISOString(), t.toISOString())
        .then((evs) => enterReconMode(unreconciled(
          evs.filter((ev) => !viewCals.find((c) => c.id === ev.calendar_id)?.hidden),
          calendars, t,
        )));
    } else enterReconMode(unreconciled(visible, calendars, t));
  };

  // keyboard shortcuts (Notion/Google parity)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // an IME's own keys (the Enter that commits a conversion, its Escape)
      // are the IME's: the Enter saved and closed a half-typed title
      if (e.isComposing || e.keyCode === 229) return;
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      // ignore global shortcuts while a grid drag is in progress (Esc is
      // handled by the drag itself)
      if (document.body.dataset.dragging) return;

      // Settings and Help work from anywhere, even mid-typing (as in any Mac app)
      if (mod && !e.shiftKey && !e.altKey && e.key === ",") {
        e.preventDefault();
        setHelpTab(null);
        setSettingsTab((t) => (t ? null : "general"));
        return;
      }
      if (mod && !e.altKey && (e.key === "/" || e.key === "?")) {
        e.preventDefault();
        setSettingsTab(null);
        setHelpTab((t) => (t ? null : "shortcuts"));
        return;
      }
      // (their own Escape closes them; nothing else reaches the calendar)
      if (settingsTab || helpTab) return;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }
      // (letters only: ⌘X here deleted an event, ⌘C canceled one)
      // (not while the event under review is open over the card: its Escape
      // closes the editor, and y / x / c don't answer behind it)
      if (reconMode && !typing && !mod && !e.altKey && !anyOverlay) {
        const k = e.key.toLowerCase();
        if (k === "y") { e.preventDefault(); reconAdvance("done"); return; }
        if (k === "x" || k === "n") { e.preventDefault(); reconAdvance("deleted"); return; }
        if (k === "c") { e.preventDefault(); reconAdvance("canceled"); return; }
        if (k === "s" || e.key === " ") { e.preventDefault(); reconAdvance("skip"); return; }
        if (k === "m") { e.preventDefault(); reconAdvance("open"); return; }
        if (e.key === "Escape") { e.preventDefault(); reconAdvance("exit"); return; }
      }
      // Escape works even while typing (closes the editor, like Google/Notion)
      if (e.key === "Escape") {
        // the topmost layer only: the scope dialog, then the command menu or
        // quick create, then the editor (Escape in ⌘K dropped panel edits)
        if (pendingScope) setPendingScope(null);
        else if (cmdOpen) setCmdOpen(false);
        else if (quickOpen) setQuickOpen(false);
        else if (anyOverlay) {
          setPanel({ mode: "closed" });
        } else if (selected.length === 0 && isolated) {
          // (a selection clears first; then the isolated view ends)
          setIsolated(null);
        } else {
          setSelected([]);
          dismissToast();
        }
        return;
      }
      if (typing) return;

      // the menu bar's shortcuts (File, View, Go)
      if (mod && !e.altKey && !e.shiftKey) {
        const viewKey = { "1": "day", "2": "week", "3": "month", "4": "list", "5": "insights" }[e.key];
        if (viewKey) {
          e.preventDefault();
          menuRef.current(`view-${viewKey}`);
          return;
        }
        const cmd = { n: "new-event", t: "today", "[": "prev", "]": "next", g: "goto", "\\": "sidebar" }[e.key.toLowerCase()];
        if (cmd) {
          e.preventDefault();
          menuRef.current(cmd);
          return;
        }
      }
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        menuRef.current("notes");
        return;
      }
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        menuRef.current("sync");
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoLast();
        return;
      }
      // (⌘+ on a Mac keyboard is ⇧⌘=: the key reads "+" with shift held)
      if (mod && !e.altKey && ((e.key === "=" && !e.shiftKey) || e.key === "+")) {
        e.preventDefault();
        setHourPx((h) => Math.min(120, h + 12));
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key === "-") {
        e.preventDefault();
        setHourPx((h) => Math.max(24, h - 12));
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key === "0") {
        e.preventDefault();
        setHourPx(48);
        return;
      }
      // (declined invitations, as Notion: ⇧⌘D)
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setPrefs({ showDeclined: !getPrefs().showDeclined });
        return;
      }
      if (mod && e.shiftKey && (e.key === "." || e.key === ">")) {
        e.preventDefault();
        setHourPx((h) => Math.min(120, h + 12));
        return;
      }
      if (mod && e.shiftKey && (e.key === "," || e.key === "<")) {
        e.preventDefault();
        setHourPx((h) => Math.max(24, h - 12));
        return;
      }
      // (a real ⌘⇧0 reports ")": the shifted key)
      if (mod && e.shiftKey && (e.code === "Digit0" || e.key === "0" || e.key === ")")) {
        e.preventDefault();
        setHourPx(48);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        toggleWeekends();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "a" && !anyOverlay && (view === "week" || view === "day")) {
        e.preventDefault();
        setSelected(sortedVisible);
        showToast(`Selected ${sortedVisible.length} events`, false);
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "c" && selected.length > 0) {
        e.preventDefault();
        clipboardRef.current = selected.map(copyInputOf);
        cutFromRef.current = null;
        showToast(
          selected.length === 1 ? `Copied “${selected[0].summary}”` : `Copied ${selected.length} events`,
          false,
        );
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "x" && selected.length > 0) {
        e.preventDefault();
        // a cut is a move: everything comes along (a copy, ⌘C, is lean)
        // (a read-only event can't move, only be copied: the lean copy,
        // or its owner's guests would be invited to yours)
        clipboardRef.current = selected.map((ev) => (isReadOnly(ev) ? inputOf(ev) : restoreInputOf(ev)));
        cutFromRef.current = selected.map((ev) => `${ev.calendar_id}/${ev.id}`);
        bulkRemove(selected);
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "v" && clipboardRef.current?.length) {
        e.preventDefault();
        // a copied event from someone else's calendar pastes into yours
        const mine =
          calendars.find((k) => calendarEditable(k) && k.is_primary) ?? calendars.find((k) => calendarEditable(k));
        // onto the anchored day while it's on screen, else the first day
        // shown (a swiped week no longer shows its anchor)
        const shown = range.days.length ? range.days : [anchor];
        const target = shown.some((d) => isSameDay(d, anchor)) ? anchor : shown[0];
        const cutFrom = cutFromRef.current;
        // the copied events keep their days apart: the earliest one's day
        // goes to the target (a Mon + Wed copy all landed on one day)
        const dayOf = (iso: string) => startOfDay(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso));
        const earliest = Math.min(...clipboardRef.current.map((c) => dayOf(c.start).getTime()));
        const shiftDays = Math.round((startOfDay(target).getTime() - earliest) / 86400000);
        const pasted: EventInput[] = [];
        // the cut events' ids: their star and review mark move with them
        const movedFrom: (string | null)[] = [];
        for (const [i, cut] of clipboardRef.current.entries()) {
          const src = cutFrom?.[i];
          // (by calendar and id: a guest's read-only calendar holds your
          // meeting under the same id, and by id alone the cut never looked
          // gone, so the paste was a lean copy without guests or Meet)
          const srcId = src?.slice(src.lastIndexOf("/") + 1);
          const gone = src != null && liveId(srcId!) === srcId && !eventsRef.current.some((e) => `${e.calendar_id}/${e.id}` === src);
          movedFrom.push(gone ? srcId! : null);
          const c0 = gone ? cut : leanCopy(cut);
          const c = calendarEditable(calOf(c0.calendar_id)) || !mine ? c0 : { ...c0, calendar_id: mine.id };
          if (c.all_day) {
            // keep the copied span (calendar days, DST-safe)
            const span = Math.max(1, Math.round(
              (Date.parse(`${c.end.slice(0, 10)}T12:00:00Z`) - Date.parse(`${c.start.slice(0, 10)}T12:00:00Z`)) / 86400000));
            const day = addDays(dayOf(c.start), shiftDays);
            pasted.push({ ...c, start: toDateOnly(day), end: toDateOnly(addDays(day, span)) });
          } else {
            // the copied time of day, on its day moved like the others (wall
            // clock: a paste across a DST change keeps 10 AM at 10 AM)
            const from = new Date(c.start);
            const dur = new Date(c.end).getTime() - from.getTime();
            const start = new Date(from);
            start.setDate(start.getDate() + shiftDays);
            pasted.push({ ...c, start: toLocalISO(start), end: toLocalISO(new Date(start.getTime() + dur)) });
          }
        }
        // a paste the isolated view would hide (a read-only calendar's copy
        // goes to yours) ends the isolation, so the paste is seen
        if (isolated && pasted.some((p) => p.calendar_id !== isolated)) setIsolated(null);
        const moved = (from: string | null, id: string | null) => {
          if (!from || !id) return;
          carryStar(from, id);
          carryRecon(from, id);
          // and where its note was placed by hand
          const pin = notePin(from);
          if (pin) setNotePin(id, pin);
        };
        if (pasted.length === 1) void actions.create(pasted[0]).then((id) => moved(movedFrom[0], id));
        else if (backend) {
          // one paste, one ⌘Z (each create took its own undo: ⌘Z took back
          // only the last event pasted)
          const be = backend;
          void (async () => {
            const made: { cal: string; id: string }[] = [];
            for (const [i, input] of pasted.entries()) {
              try {
                const id = await be.createEvent(input);
                if (id) made.push({ cal: input.calendar_id, id });
                moved(movedFrom[i], id);
              } catch {
                /* counted below */
              }
            }
            if (made.length === 0) return showToast("Couldn't paste the events", false);
            recordUndo(
              made.length === pasted.length ? `Pasted ${made.length} events` : `Pasted ${made.length} of ${pasted.length} events`,
              async () => {
                await Promise.all(made.map(({ cal, id }) => be.deleteEvent(cal, liveId(id))));
              },
            );
          })();
        }
        clipboardRef.current = clipboardRef.current.map(leanCopy);
        cutFromRef.current = null;
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "d" && selected.length > 0) {
        e.preventDefault();
        // a read-only event's copy goes to your calendar: shown (as ⌘V),
        // not hidden by an isolated read-only calendar
        if (isolated && selected.some(isReadOnly)) setIsolated(null);
        if (selected.length === 1) actions.duplicate(selected[0]);
        else bulkDuplicate(selected);
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        void joinNext();
        return;
      }
      if (mod) return;

      // the open event's panel: Delete / Backspace delete it (Notion), unless
      // a field in it has the focus (that's editing text, handled above)
      if ((e.key === "Backspace" || e.key === "Delete") && panel.mode === "view" && !quickOpen && !cmdOpen && !pendingScope) {
        e.preventDefault();
        void actions.remove(panel.event);
        return;
      }

      if (anyOverlay) return;

      switch (e.key) {
        case "t":
        case "T":
          setPanDays(0);
          setAnchor(now());
          setView((v) => (v === "insights" ? "week" : v));
          break;
        case "d":
        case "1":
          if (view === "week" && panDays) setAnchor(range.days[0]); // from the days shown
          setDayCount(1);
          setView("day");
          break;
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9":
          if (view === "week" && panDays) setAnchor(range.days[0]); // from the days shown
          setDayCount(Number(e.key));
          setView("day");
          break;
        case "e":
          if (selectedOne) openEvent(selectedOne);
          break;
        case "x": {
          // Notion: select/deselect the highlighted (hovered) event (in the
          // grid: elsewhere the last hover is another view's)
          if (view !== "week" && view !== "day") break;
          const h = hoveredRef.current;
          if (h) toggleSelect(h);
          else if (selected.length) setSelected([]);
          break;
        }
        case "w":
        case "0":
          setView("week");
          break;
        case "m":
          changeView("month");
          break;
        case "l":
          changeView("list");
          break;
        case "r":
          startReview();
          return;
        case "g":
          setSpotlight((s) => !s);
          return;
        case "a":
          menuRef.current("notes");
          break;
        case "i":
          changeView("insights");
          break;
        case "c":
          e.preventDefault();
          setQuickOpen(true);
          break;
        case "j":
          step(1);
          break;
        case "k":
          step(-1);
          break;
        case "ArrowLeft":
          step(-1);
          break;
        case "ArrowRight":
          step(1);
          break;
        case "n":
          cycleSelection(1);
          break;
        case "N":
          cycleSelection(-1);
          break;
        case "b":
        case "p":
          cycleSelection(-1);
          break;
        case "?":
          setSettingsTab(null);
          setHelpTab((t) => (t ? null : "shortcuts"));
          break;
        case "`":
          setSidebarHidden((h) => !h);
          break;
        case ".":
        case "/":
          e.preventDefault();
          setCmdOpen(true);
          break;
        case "Enter":
          if (selectedOne) openEvent(selectedOne);
          break;
        case "Backspace":
        case "Delete":
          if (selected.length > 0 && (view === "week" || view === "day")) {
            e.preventDefault();
            // only what's on screen (an event opened in month view and
            // kept selected into another week was deleted unseen)
            const shown = selected.filter((s) => sortedVisible.some((v) => v.id === s.id && v.calendar_id === s.calendar_id));
            if (shown.length) bulkRemove(shown);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, changeView, reconMode, backend, enterReconMode, view, panDays, range, anchor, anyOverlay, selected, selectedOne, actions, cycleSelection, sortedVisible, visible, openEvent, bulkRemove, bulkDuplicate, toggleSelect, toggleWeekends, calendars, calOf, panel, quickOpen, cmdOpen, pendingScope, isolated, viewCals, settingsTab, helpTab]);

  // Pinch on the trackpad zooms how many days are shown: spreading the
  // fingers shows fewer (each wider), squeezing shows more, 1 to 9, in
  // proportion to the pinch; the day under the fingers stays where it is.
  // Chromium reports a pinch as a ctrl+wheel; WebKit (the app's webview) as
  // gesturestart/gesturechange with a scale.
  const mainRef = useRef<HTMLDivElement>(null);
  const zoomStateRef = useRef({ view, dayCount, days: range.days });
  zoomStateRef.current = { view, dayCount, days: range.days };
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    type Pinch = { base: number; dayUnder: Date; frac: number; scale: number; t: number };
    let pinch: Pinch | null = null;
    let gesture = false;
    const begin = (clientX: number): Pinch | null => {
      const { view: v, dayCount: n, days } = zoomStateRef.current;
      if ((v !== "week" && v !== "day") || !days.length) return null;
      // Use the header viewport's unscrolled origin, not the rendered header
      // edges. With fractional column widths, scrollLeft can be quantized by
      // the browser; measuring the shifted headers then adds that rounding
      // error to the pinch fraction and can move the anchor by a whole day.
      const shown = v === "week" ? days.length : n;
      const headers = [...el.querySelectorAll<HTMLElement>(".day-head")];
      const first = headers[0]?.getBoundingClientRect();
      const last = headers[headers.length - 1]?.getBoundingClientRect();
      const weekGrid = el.querySelector<HTMLElement>(".weekview");
      const clip = weekGrid?.querySelector<HTMLElement>(".day-headers .pan-clip");
      const clipRect = clip?.getBoundingClientRect();
      const fallback = (el.querySelector(".day-clip") ?? el).getBoundingClientRect();
      const left = clipRect && weekGrid ? clipRect.left + weekGrid.scrollLeft : first?.left ?? fallback.left;
      const width = clip?.clientWidth ?? (first && last ? last.right - first.left : fallback.width);
      const frac = Math.min(0.999, Math.max(0, (clientX - left) / Math.max(1, width)));
      const underHeader = headers.findIndex((header) => {
        const rect = header.getBoundingClientRect();
        return clientX >= rect.left && clientX < rect.right;
      });
      const index = underHeader >= 0 ? underHeader : Math.floor(frac * shown);
      const dayUnder = days[Math.min(days.length - 1, index)];
      return { base: shown, dayUnder, frac, scale: 1, t: 0 };
    };
    const apply = (p: Pinch) => {
      const n = Math.min(9, Math.max(1, Math.round(p.base / p.scale)));
      const { view: v, dayCount: cur, days } = zoomStateRef.current;
      if (n === (v === "week" ? days.length : cur)) return;
      // keep the day under the fingers in the same place across the view
      const first = addDays(startOfDay(p.dayUnder), -Math.min(n - 1, Math.floor(p.frac * n)));
      setPanDays(0);
      setAnchor(first);
      setDayCount(n);
      setView("day");
    };
    const applyWheelPinch = (e: WheelEvent, cancelBrowserZoom: boolean) => {
      if (!e.ctrlKey || gesture) return;
      if (cancelBrowserZoom) e.preventDefault(); // not the page's own zoom
      const tNow = performance.now();
      if (!pinch || tNow - pinch.t > 300) pinch = begin(e.clientX);
      if (!pinch) return;
      pinch.t = tNow;
      pinch.scale *= Math.exp(-e.deltaY / 100);
      apply(pinch);
    };
    let controlHeld = false;
    const onWheelPassive = (e: WheelEvent) => {
      // Normal wheel/trackpad input must not wait for this main-thread
      // listener. WebKit reports native pinch with gesture events; this branch
      // also supports synthetic ctrl-wheel pinch events used by browser tests.
      if (!controlHeld) applyWheelPinch(e, false);
    };
    const onControlWheel = (e: WheelEvent) => applyWheelPinch(e, true);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Control" || controlHeld) return;
      controlHeld = true;
      // A real Ctrl+wheel gesture should zoom the app, not the web page. Keep
      // the cancelable listener installed only while the user holds Control.
      el.addEventListener("wheel", onControlWheel, { passive: false });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Control" || !controlHeld) return;
      controlHeld = false;
      el.removeEventListener("wheel", onControlWheel);
    };
    const onBlur = () => {
      controlHeld = false;
      el.removeEventListener("wheel", onControlWheel);
    };
    type GestureLike = Event & { scale?: number; clientX?: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesture = true;
      pinch = begin((e as GestureLike).clientX ?? el.getBoundingClientRect().left + el.clientWidth / 2);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const sc = (e as GestureLike).scale;
      if (!pinch || !sc) return;
      pinch.scale = sc;
      apply(pinch);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesture = false;
      pinch = null;
    };
    el.addEventListener("wheel", onWheelPassive, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("wheel", onWheelPassive);
      el.removeEventListener("wheel", onControlWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);

  // Clicking outside the open editor dismisses it; the grid stays live
  // (clicking another chip switches panels directly) — Google behavior.
  useEffect(() => {
    if (panel.mode === "closed") return;
    const onDown = (ev: PointerEvent) => {
      const el = document.querySelector(".event-panel");
      // resizing a side pane is not leaving the event
      if ((ev.target as Element | null)?.closest?.(".pane-resize")) return;
      // the recurring-scope dialog belongs to the editor's Save/Delete;
      // Settings, Help, ⌘K, menus and pills are their own layers (a click
      // in Settings dropped the editor's unsaved edits)
      if ((ev.target as Element | null)?.closest?.(".scope-scrim, .set-scrim, .cmdk-scrim, .qc-scrim, .ctx-scrim, .ctx-menu, .isolate-pill, .recon-pill, .toast")) return;
      if (el && !el.contains(ev.target as Node)) {
        // Mark this gesture so the grid treats it as dismiss-only: React may
        // flush the close before the grid's own pointerdown handler runs.
        document.body.dataset.panelDismiss = String(ev.timeStamp);
        setPanel({ mode: "closed" });
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [panel.mode]);

  // ⌥C global shortcut (Rust) asks us to open quick create
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("quick-create", () => setQuickOpen(true)).then((f) => (un = f));
    });
    return () => un?.();
  }, []);

  // a change Google refused for good was put back to Google's copy (sync
  // pass): say so, or the edit just silently undoes itself
  const signInToldRef = useRef<string | null>(null);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ reverted?: string[]; errors?: string[] }>("sync-status", ({ payload }) => {
        // a dead Google sign-in (the token expired or was revoked): said
        // once, not every pass; the account page already asks to connect
        const signIn = (payload?.errors ?? []).find((e) => e.startsWith("Google sign-in expired"));
        if (signIn && signIn !== signInToldRef.current) {
          signInToldRef.current = signIn;
          showToast(signIn, false);
        }
        const titles = payload?.reverted ?? [];
        if (titles.length === 0) return;
        const name = titles[0] ? `“${titles[0]}”` : "an event";
        showToast(
          titles.length === 1
            ? `Google didn't accept the change to ${name}: it's back to Google's version`
            : `Google didn't accept changes to ${titles.length} events: they're back to Google's versions`,
          false,
        );
      }).then((f) => (un = f));
    });
    return () => un?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // picking an event in the menu bar dropdown opens it here
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !backend) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<string>("tray-open-event", async ({ payload: key }) => {
        const t = now();
        const evs = await backend.listEvents(addDays(t, -1).toISOString(), addDays(t, 1).toISOString());
        const ev = evs.find((e) => `${e.calendar_id}/${e.id}` === key);
        if (!ev) return;
        setView((v) => (v === "week" || v === "day" ? v : "week"));
        setAnchor(eventDates(ev).start);
        setPanel({ mode: "view", event: ev });
      }).then((f) => (un = f));
    });
    return () => un?.();
  }, [backend]);

  // answering the hourly nudge: open on now, on the event you're in (or a
  // new one for this hour) so it can be brought up to date
  const calendarsRef = useRef(calendars);
  calendarsRef.current = calendars;
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || !backend) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("nudge-open", async () => {
        const t = now();
        const evs = await backend.listEvents(addDays(t, -1).toISOString(), addDays(t, 1).toISOString());
        const cur = currentEvent(evs, calendarsRef.current, t);
        setPanDays(0);
        setAnchor(t);
        setView((v) => (v === "week" || v === "day" ? v : "week"));
        if (cur) {
          setSelected([cur]);
          setPanel({ mode: "view", event: cur });
        } else {
          const h = thisHour(t);
          setPanel({ mode: "new", draft: { start: h.start, end: h.end, allDay: false } });
        }
      }).then((f) => (un = f));
    });
    return () => un?.();
  }, [backend]);

  const connect = async () => {
    if (!backend) return;
    setConnecting(true);
    try {
      await backend.connectGoogle();
    } catch (e) {
      // (the button just reset: Rust's reason, with what to do, went to the
      // console as an unhandled rejection)
      showToast(`Couldn't connect Google: ${e}`, false);
    } finally {
      setConnecting(false);
    }
  };

  const quickDraft = () => {
    const s = now();
    s.setMinutes(0, 0, 0);
    s.setHours(s.getHours() + 1);
    openDraft({ start: s, end: new Date(s.getTime() + 3600_000), allDay: false });
  };

  // The menu bar (and its ⌘ shortcuts): each command does what its key does.
  // Commands that are a key already replay that key, so they keep every
  // guard the key has (a drag in progress, review mode).
  const key = (k: string, mods: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
  menuRef.current = (cmd: string) => {
    const views: Record<string, View> = { "view-week": "week", "view-month": "month", "view-list": "list", "view-insights": "insights" };
    if (cmd !== "settings" && cmd !== "help" && cmd !== "shortcuts") {
      // (flushed: a replayed key is read by the handler at once)
      flushSync(() => {
        setSettingsTab(null);
        setHelpTab(null);
      });
    }
    if (views[cmd]) return changeView(views[cmd]);
    switch (cmd) {
      case "settings": setHelpTab(null); return setSettingsTab("general");
      case "help": setSettingsTab(null); return setHelpTab("guide");
      case "shortcuts": setSettingsTab(null); return setHelpTab("shortcuts");
      case "new-event": return quickDraft();
      case "quick-create": return setQuickOpen(true);
      case "command-menu": case "goto": return setCmdOpen(true);
      case "sync":
        if (!backend || !authed) return showToast("Connect Google in Settings › Calendar accounts to sync", false);
        showToast("Syncing with Google…", false);
        return void backend.syncNow().then(() => showToast("Synced with Google", false), (err) => showToast(`Couldn't sync with Google: ${err}`, false));
      case "view-day":
        if (view === "week" && panDays && range.days.length) setAnchor(range.days[0]);
        setDayCount(1);
        return setView("day");
      case "today": setPanDays(0); setAnchor(now()); return setView((v) => (v === "insights" ? "week" : v));
      case "prev": return step(-1);
      case "next": return step(1);
      case "weekends": return toggleWeekends();
      case "sidebar": return setSidebarHidden((h) => !h);
      case "zoom-in": return setHourPx((h) => Math.min(120, h + 12));
      case "zoom-out": return setHourPx((h) => Math.max(24, h - 12));
      case "zoom-reset": return setHourPx(48);
      case "notes": {
        const show = !getPrefs().showNotes;
        setPrefs({ showNotes: show });
        return showToast(show ? "Notes shown" : "Notes hidden · A to show", false);
      }
      case "join": return key("j", { metaKey: true });
      // (with an event open too: the key's path skips overlays)
      case "reconcile":
        setPanel({ mode: "closed" });
        setQuickOpen(false);
        setCmdOpen(false);
        return startReview();
    }
  };

  return (
    <Profiler id="CalendarApp" onRender={profileCalendarRender}>
    <BackendContext.Provider value={backend}>
      <div
        className={"app" + (sidebarHidden ? " sidebar-hidden" : "")}
        style={{ "--sidebar-w": `${sidebarW}px`, "--panel-w": `${panelW}px` } as React.CSSProperties}
      >
        <Sidebar
          backend={backend}
          calendars={calendars}
          anchor={miniAnchor}
          today={toDateOnly(now())}
          authed={authed}
          events={visible}
          onPickDate={pickDate}
          isolated={isolated}
          onIsolate={setIsolated}
        />
        {!sidebarHidden && (
          <PaneResize
            pane={SIDEBAR_PANE}
            width={sidebarW}
            onWidth={setSidebarW}
            paneSide="left"
            className="pane-resize-sidebar"
            label="Resize the sidebar"
          />
        )}
        <div className="main" ref={mainRef}>
          <TopBar
            anchor={range.days.length > 0 ? range.days[0] : anchor}
            rangeEnd={range.days.length > 0 ? range.days[range.days.length - 1] : view === "list" ? addDays(range.end, -1) : undefined}
            view={view}
            dayCount={dayCount}
            authed={authed}
            connecting={connecting}
            onConnect={connect}
            onViewChange={changeView}
            onDayCount={setDayCount}
            seamStyle={seamStyle}
            onSeamStyle={setSeamStyle}
            spotlight={spotlight}
            onSpotlight={() => setSpotlight((s) => !s)}
            onToday={() => menuRef.current("today")}
            onStep={step}
            onOpenCommand={() => setCmdOpen(true)}
          />
          {(view === "week" || view === "day") && (
            <Profiler id="WeekView" onRender={profileCalendarRender}>
            <WeekView
              backend={backend}
              days={range.days}
              events={visible}
              calendars={calendars}
              selected={selected}
              draft={panel.mode === "new" ? panel.draft : null}
              draftCalendarId={isolated}
              onToggleSelect={toggleSelect}
              onClipboard={clipboardOp}
              onPan={pan}
              hideWeekends={view === "week" && hideWeekends}
              seamStyle={seamStyle}
              onSelectMany={(evs: CalendarEvent[]) => setSelected(evs)}
              onMoveSelected={moveSelected}
              panelOpen={panel.mode !== "closed"}
              hourPx={hourPx}
              secondaryTz={secondaryTz}
              onHover={(e) => (hoveredRef.current = e)}
              actions={actions}
              onOpenEvent={openEvent}
              onSelect={(e) => setSelected(e ? [e] : [])}
              onDraft={openDraft}
            />
            </Profiler>
          )}
          {view === "month" && (
            <MonthView
              anchor={anchor}
              events={visible}
              calendars={calendars}
              onOpenEvent={openEvent}
              onOpenDay={(d) => {
                // one day, even after a 3-day view (the count persists)
                setDayCount(1);
                setAnchor(d);
                setView("day");
              }}
              hideWeekends={hideWeekends}
              onDraftDay={(d) => {
                openDraft({ start: d, end: addDays(d, 1), allDay: true });
              }}
            />
          )}
          {view === "list" && (
            <AgendaView
              anchor={anchor}
              start={range.start}
              end={range.end}
              events={visible}
              calendars={calendars}
              onOpenEvent={openEvent}
            />
          )}
          {view === "insights" && (
            <InsightsView backend={backend} events={events} calendars={calendars} />
          )}
        </div>

        <EventPanel
          backend={backend}
          calendars={calendars}
          liveEvent={panelLive}
          isolated={isolated}
          state={panel}
          actions={actions}
          onClose={() => setPanel({ mode: "closed" })}
        />
        {panel.mode !== "closed" && (
          <PaneResize
            pane={PANEL_PANE}
            width={panelW}
            onWidth={setPanelW}
            paneSide="right"
            className="pane-resize-panel"
            label="Resize the event panel"
          />
        )}
        {quickOpen && (
          <QuickCreate
            backend={backend}
            calendars={calendars}
            isolated={isolated}
            actions={actions}
            onClose={() => setQuickOpen(false)}
          />
        )}
        {settingsTab && (
          <SettingsDialog
            tab={settingsTab}
            onTab={setSettingsTab}
            onClose={() => setSettingsTab(null)}
            onShortcuts={() => { setSettingsTab(null); setHelpTab("shortcuts"); }}
            backend={backend}
            calendars={calendars}
            authed={authed}
            hideWeekends={hideWeekends}
            onHideWeekends={(v) => { if (v !== hideWeekends) toggleWeekends(); }}
            secondaryTz={secondaryTz}
            onSecondaryTz={setSecondaryTz}
            seamStyle={seamStyle}
            onSeamStyle={setSeamStyle}
            onConnect={() => void connect()}
          />
        )}
        {helpTab && <HelpDialog tab={helpTab} onTab={setHelpTab} onClose={() => setHelpTab(null)} />}
        {cmdOpen && (
          <CommandMenu
            backend={backend}
            calendars={calendars}
            onClose={() => setCmdOpen(false)}
            onGoto={(d) => { setPanDays(0); setAnchor(d); setView((v) => (v === "insights" ? "week" : v)); }}
            // Day view is one day, as the menu bar's (not the last N-day count)
            onView={(v) => (v === "day" ? menuRef.current("view-day") : changeView(v))}
            onToday={() => menuRef.current("today")}
            onSync={() => menuRef.current("sync")}
            onNewEvent={quickDraft}
            onOpenEvent={(e) => {
              // a search hit opens where it is (Notion): go to its days
              setPanDays(0);
              setAnchor(eventDates(e).start);
              setView((v) => (v === "week" || v === "day" ? v : "week"));
              openEvent(e);
            }}
            secondaryTz={secondaryTz}
            onSecondaryTz={setSecondaryTz}
          />
        )}

        {pendingScope && (
          <ScopeDialog
            pending={pendingScope}
            onPick={applyScope}
            onCancel={() => {
              // a cut whose delete was cancelled left its original in place
              const id = pendingScope.event.id;
              const key = `${pendingScope.event.calendar_id}/${id}`;
              if (pendingScope.kind === "delete" && cutFromRef.current?.includes(key))
                cutFromRef.current = cutFromRef.current.map((x) => (x === key ? null : x));
              setPendingScope(null);
            }}
          />
        )}
        {isolated && (() => {
          const cal = calendars.find((c) => c.id === isolated);
          if (!cal) return null;
          return (
            <div className={"isolate-pill" + (reconMode ? " lifted" : "")} data-testid="isolate-pill" role="status">
              <span className="isolate-dot" style={{ background: colorOf(calendars, cal.id) }} />
              <span className="isolate-text">
                Showing only <b>{cal.summary}</b>
              </span>
              <button className="isolate-exit" onClick={() => setIsolated(null)} title="Show all calendars (Esc)">
                Show all <kbd>Esc</kbd>
              </button>
            </div>
          );
        })()}
        {reconMode && (() => {
          // the review card: one event at a time, three clearly different
          // answers, the rest quiet
          const ev = reconMode.queue[reconMode.idx];
          const { start, end } = eventDates(ev);
          const n = reconMode.queue.length;
          return (
            <div className="recon-pill review-card" data-testid="recon-pill" role="dialog" aria-label="Review">
              <div className="review-head">
                <span className="review-q">Did this happen?</span>
                <span className="recon-count">{reconMode.idx + 1} of {n}</span>
                <button className="review-close" onClick={() => reconAdvance("exit")} title="Done reviewing (Esc)" aria-label="Done reviewing">
                  ✕
                </button>
              </div>
              <div className="review-progress" aria-hidden="true">
                <span style={{ width: `${(reconMode.idx / Math.max(1, n)) * 100}%` }} />
              </div>
              <div className="review-event">
                <span className="review-dot" style={{ background: colorOf(calendars, ev.calendar_id) }} />
                <b className="review-title">{ev.summary || "(No title)"}</b>
                <span className="review-when">{format(start, "EEE MMM d")} · {fmtChipRange(start, end)}</span>
              </div>
              <div className="review-answers">
                <button className="review-btn yes" onClick={() => reconAdvance("done")} data-testid="recon-btn-yes">
                  <span className="review-ic">✓</span>
                  <span className="review-label">It happened<small>counted as done</small></span>
                  <kbd>Y</kbd>
                </button>
                <button className="review-btn canceled" onClick={() => reconAdvance("canceled")} data-testid="recon-btn-canceled">
                  <span className="review-ic">⊘</span>
                  <span className="review-label">Canceled<small>kept, struck through</small></span>
                  <kbd>C</kbd>
                </button>
                <button className="review-btn no" onClick={() => reconAdvance("deleted")} data-testid="recon-btn-no">
                  <span className="review-ic">✕</span>
                  <span className="review-label">Didn't happen<small>deleted · ⌘Z undoes</small></span>
                  <kbd>N</kbd>
                </button>
              </div>
              <div className="review-more">
                <button onClick={() => reconAdvance("skip")}>Skip <kbd>S</kbd></button>
                <button onClick={() => reconAdvance("open")}>Open it <kbd>M</kbd></button>
                <button onClick={() => reconAdvance("exit")}>Done <kbd>Esc</kbd></button>
              </div>
            </div>
          );
        })()}
        {/* (not over an open event: centered on the window it covered the
            panel's reminder row and, scrolled, its Delete button) */}
        {!reconMode && !sweepDismissed && panel.mode === "closed" && (() => {
          const y0 = startOfDay(addDays(now(), -1));
          const q = unreconciled(visible, calendars, now(), { from: y0, to: startOfDay(now()) });
          if (q.length === 0) return null;
          const dismiss = () => {
            setSweepDismissedOn(toDateOnly(now()));
            try {
              localStorage.setItem("sweepDismissed", toDateOnly(now()));
            } catch {
              /* per-viewer convenience */
            }
          };
          return (
            <div className="sweep-pill" data-testid="sweep-banner">
              <span>
                Yesterday: <b>{q.length} event{q.length > 1 ? "s" : ""}</b> to review
              </span>
              <button
                className="btn"
                title="Mark every one as happened"
                onClick={() => {
                  setReconAll(q, "done");
                  dismiss();
                  showToast("Marked yesterday's events as happened", false);
                }}
              >
                ✓ All happened
              </button>
              <button
                className="btn btn-accent"
                onClick={() => {
                  dismiss();
                  enterReconMode(q);
                }}
              >
                Review
              </button>
              <button className="toast-close" aria-label="Dismiss" onClick={dismiss}>
                ✕
              </button>
            </div>
          );
        })()}
        {toast && (
          <div className="toast" data-testid="toast">
            <span>{toast.label}</span>
            {toast.canUndo && (
              <button className="toast-undo" onClick={() => undoLast()}>
                Undo <kbd>⌘Z</kbd>
              </button>
            )}
            <button className="toast-close" onClick={() => dismissToast()} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
      </div>
    </BackendContext.Provider>
    </Profiler>
  );
}
