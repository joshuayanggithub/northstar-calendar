import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ProfilerOnRenderCallback,
} from "react";
import {
  addDays,
  addMonths,
  addWeeks,
  eventDates,
  now,
  shiftWallClock,
  startOfDay,
  toDateOnly,
  toLocalISO,
  weekDays,
  type WallShift,
} from "../lib/dates";
import { useRef } from "react";
import {
  BackendContext,
  useAuth,
  useBackendInit,
  useCalendars,
  useEvents,
  useVisibleEvents,
} from "../lib/useBackend";
import { calendarEditable, readOnlyEvent } from "../lib/types";
import { copiedKeys, linkCopy } from "../lib/copies";
import type { Calendar, CalendarEvent, EventInput } from "../lib/types";
import { ScopeDialog, type PendingScope, type Scope } from "./ScopeDialog";
import { dismissToast, onToast, recordUndo, showToast, undoLast } from "../lib/undo";
import { splitDrill } from "../lib/drill";
import { setAutoGoals } from "../lib/stars";
import { reconKey, setRecon, subscribeRecon, unreconciled } from "../lib/recon";
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

export type View = "day" | "week" | "month" | "list" | "insights";

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
  const previousMinutes = raw?.useDefault === false
    ? raw.overrides?.[0]?.minutes ?? null
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
  update(ev: CalendarEvent, input: EventInput, label?: string): Promise<void>;
  remove(ev: CalendarEvent): Promise<void>;
  /** Delete just this event — for a recurring one, just this occurrence —
   *  without the scope prompt: reconciliation's "didn't happen". Undoable. */
  removeOccurrence(ev: CalendarEvent): Promise<void>;
  /** Delete the whole recurring series an instance belongs to. Not undoable. */
  removeSeries(ev: CalendarEvent): Promise<void>;
  /** Set (null clears) the red-pen note on just this event — for a
   *  recurring one, this occurrence — keeping the rest of its description.
   *  Undoable; never prompts for scope. */
  setNote(ev: CalendarEvent, note: string | null): Promise<void>;
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
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Date>(() => now());
  const [panel, setPanel] = useState<PanelState>({ mode: "closed" });
  const [quickOpen, setQuickOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [selected, setSelected] = useState<CalendarEvent[]>([]);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [sidebarW, setSidebarW] = usePaneWidth(SIDEBAR_PANE);
  const [panelW, setPanelW] = usePaneWidth(PANEL_PANE);
  const [dayCount, setDayCount] = useState(1); // 1-9 day view width (Notion 2-9)
  const [hourPx, setHourPx] = useState(48); // hour zoom (shift+cmd+. / , / 0)
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
  const [reconMode, setReconMode] = useState<{ queue: CalendarEvent[]; idx: number } | null>(null);
  const [spotlight, setSpotlight] = useState(false);
  const [, reconTickApp] = useState(0);
  useEffect(() => subscribeRecon(() => reconTickApp((n) => n + 1)), []);
  const [sweepDismissed, setSweepDismissed] = useState(() => {
    try {
      return localStorage.getItem("sweepDismissed") === toDateOnly(now());
    } catch {
      return true;
    }
  });
  const clipboardRef = useRef<EventInput[] | null>(null);
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
      const today = startOfDay(now());
      return { start: addDays(weekDays(today)[0], -21), end: addDays(today, 8), days: [] };
    }
    const gridStart = weekDays(new Date(anchor.getFullYear(), anchor.getMonth(), 1))[0];
    return { start: gridStart, end: addDays(gridStart, 42), days: [] };
  }, [view, anchor, dayCount, hideWeekends, panDays]);

  // Fetch window: quantized to week blocks with a week of padding each side,
  // so swiping day-by-day never refetches until the view leaves the block —
  // refetch-per-pan was the main source of swipe jitter.
  const fetchStart = useMemo(() => {
    const s = weekDays(range.start)[0];
    return addDays(s, -7);
  }, [Math.floor(range.start.getTime() / (7 * 86400000))]); // eslint-disable-line react-hooks/exhaustive-deps
  const fetchEnd = useMemo(
    () => addDays(weekDays(range.end)[0], 14),
    [Math.floor(range.end.getTime() / (7 * 86400000))], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const events = useEvents(backend, fetchStart, fetchEnd);
  const shownCals = useVisibleEvents(events, calendars);
  // an event copied in from someone else's calendar: the copy stands for it
  const copied = useMemo(() => copiedKeys(events, (e) => readOnlyEvent(e, calendars)), [events, calendars]);
  const visible = useMemo(
    () => (copied.size ? shownCals.filter((e) => !copied.has(`${e.calendar_id}/${e.id}`)) : shownCals),
    [shownCals, copied],
  );

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

  const actions: EventActions = useMemo(
    () => ({
      async create(input) {
        if (!backend) return null;
        const id = await backend.createEvent(input);
        recordUndo(`Created “${input.summary}”`, async () => {
          await backend.deleteEvent(input.calendar_id, id);
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
          askScope({ kind: "edit", event: ev, input, label, canSplit: true });
          return;
        }
        const prev = undoInputOf(ev);
        await backend.updateEvent(ev.id, eventMetadataSafeUpdate(ev, input), ev.calendar_id);
        recordUndo(label ?? `Updated “${ev.summary}”`, async () => {
          // restore, including a calendar move back if one happened
          await backend.updateEvent(ev.id, prev, input.calendar_id);
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
          return;
        }
        const snapshot = undoInputOf(ev);
        await backend.deleteEvent(ev.calendar_id, ev.id);
        // close any panel showing it and drop selection
        setPanel((p) =>
          p.mode === "view" && p.event.id === ev.id && p.event.calendar_id === ev.calendar_id
            ? { mode: "closed" }
            : p,
        );
        setSelected((sel) => sel.filter((s) => !(s.id === ev.id && s.calendar_id === ev.calendar_id)));
        recordUndo(`Deleted “${ev.summary}”`, async () => {
          await backend.createEvent(snapshot);
        });
      },
      async removeOccurrence(ev) {
        if (!backend) return;
        if (isReadOnly(ev)) {
          showToast(`“${ev.summary}” is on a read-only calendar`, false);
          return;
        }
        const snapshot = undoInputOf(ev);
        await backend.deleteEvent(ev.calendar_id, ev.id);
        setPanel((p) =>
          p.mode === "view" && p.event.id === ev.id && p.event.calendar_id === ev.calendar_id
            ? { mode: "closed" }
            : p,
        );
        setSelected((sel) => sel.filter((s) => !(s.id === ev.id && s.calendar_id === ev.calendar_id)));
        recordUndo(`Didn't happen — deleted “${ev.summary}”`, async () => {
          if (ev.recurring_event_id) await backend.restoreRecurringOccurrence(ev);
          else await backend.createEvent(snapshot);
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
          await backend.setEventNote(ev.calendar_id, ev.id, previous);
        });
      },
      async removeSeries(ev) {
        if (!backend || !ev.recurring_event_id) return;
        await backend.deleteEvent(ev.calendar_id, ev.recurring_event_id);
        setPanel((p) =>
          p.mode === "view" && p.event.recurring_event_id === ev.recurring_event_id
            ? { mode: "closed" }
            : p,
        );
        setSelected([]);
        showToast(`Deleted series “${ev.summary}”`, false);
      },
      async duplicate(ev) {
        if (!backend) return;
        const input = inputOf(ev);
        // copying from a read-only calendar lands on the default calendar
        if (isReadOnly(ev)) {
          const target = calendars.find((c) => calendarEditable(c) && c.is_primary) ??
            calendars.find((c) => calendarEditable(c));
          if (!target) return;
          input.calendar_id = target.id;
        }
        const id = await backend.createEvent(input);
        recordUndo(`Duplicated “${ev.summary}”`, async () => {
          await backend.deleteEvent(input.calendar_id, id);
        });
      },
      async copyTo(ev, calendarId, series = false) {
        const cal = calOf(calendarId);
        if (!backend || !cal || !calendarEditable(cal)) return;
        let input: EventInput = { ...inputOf(ev), calendar_id: calendarId };
        let whole = false;
        if (series && ev.recurring_event_id) {
          // the series as its owner wrote it: first occurrence + the rule
          const master = await backend.getSeriesMaster(ev.calendar_id, ev.recurring_event_id).catch(() => null);
          const rule = (master?.recurrence ?? []).filter((r: string) => /^(RRULE|EXRULE|RDATE|EXDATE)/.test(r));
          const s = master?.start?.dateTime ?? master?.start?.date;
          const e = master?.end?.dateTime ?? master?.end?.date;
          if (rule.length && s && e) {
            input = { ...input, summary: master.summary ?? ev.summary, start: s, end: e, all_day: !!master.start.date, recurrence: rule };
            whole = true;
          } else {
            showToast("Couldn't read the whole series — copied this event only", false);
          }
        }
        const id = await backend.createEvent(input);
        linkCopy(ev, { calendar_id: calendarId, id });
        recordUndo(`Copied “${ev.summary}”${whole ? " (every occurrence)" : ""} to ${cal.summary}`, async () => {
          await backend.deleteEvent(calendarId, id);
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
          conference_url: null,
          updated: null,
          raw: {},
        };
        setSelected([copy]);
        setPanel({ mode: "view", event: copy });
      },
    }),
    [backend, calendars, calOf, isReadOnly, askScope],
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
  useEffect(() => {
    if (panel.mode === "view" && !panelLive) {
      // A sync delete invalidates the editor's snapshot. Leaving it open lets
      // Save/Move target a deleted event and turns the external change into a
      // confusing failure.
      setPanel({ mode: "closed" });
    }
  }, [panel.mode, panelLive]);

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
      const snapshots = deleted.map(undoInputOf);
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
              ? backend.restoreRecurringOccurrence(event)
              : backend.createEvent(snapshots[index]),
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
        const input = inputOf(ev);
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
          await Promise.all(ids.map(({ cal, id }) => backend.deleteEvent(cal, id)));
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
          const input = {
            ...inputOf(e),
            start: toLocalISO(shiftWallClock(start, shift)),
            end: toLocalISO(shiftWallClock(end, shift)),
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
          await Promise.all(movedPrevs.map(([e, prev]) => backend.updateEvent(e.id, prev, e.calendar_id)));
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
      const master = p.masterP ? await p.masterP : (p.master ?? null);
      const selectedOriginal = ev.raw?.originalStartTime?.dateTime ??
        ev.raw?.originalStartTime?.date ?? ev.start;
      const masterOriginal = master?.start?.dateTime ?? master?.start?.date;
      const firstOccurrence = !!masterOriginal &&
        (ev.all_day ? selectedOriginal === masterOriginal :
          Date.parse(selectedOriginal) === Date.parse(masterOriginal));
      const effectiveScope = scope === "following" && firstOccurrence ? "all" : scope;
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
      try {
        if (p.kind === "delete") {
          if (effectiveScope === "this") {
            await backend.deleteEvent(ev.calendar_id, ev.id);
            recordUndo(`Deleted “${ev.summary}”`, async () => {
              await backend.restoreRecurringOccurrence(ev);
            });
          } else if (effectiveScope === "all") {
            await backend.deleteEvent(ev.calendar_id, masterId);
            showToast(`Deleted series “${ev.summary}”`, false);
          } else if (rrule) {
            await backend.updateSeriesMaster(ev.calendar_id, masterId, {
              recurrence: [truncateRule(rrule, selectedOriginal, ev.all_day)],
            });
            showToast(`Deleted “${ev.summary}” and following`, false);
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
            await backend.updateEvent(ev.id, prev, input.calendar_id);
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
          if (input.reminder_minutes !== undefined) {
            const previousReminder = ev.raw?.reminders?.useDefault === false
              ? ev.raw.reminders.overrides?.[0]?.minutes ?? null : null;
            if (input.reminder_minutes !== previousReminder) {
              patch.reminders = input.reminder_minutes == null
                ? { useDefault: true }
                : { useDefault: false, overrides: [{ method: "popup", minutes: input.reminder_minutes }] };
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
          const masterDate = masterStartDate ?? (masterStart ? toDateOnly(new Date(masterStart)) : null);
          if (timesChanged && masterDate) {
            const selectedDate = ev.all_day ? ev.start : toDateOnly(new Date(ev.start));
            const newSelectedDate = input.all_day ? input.start : toDateOnly(new Date(input.start));
            const dayDelta = Math.round((Date.parse(`${newSelectedDate}T00:00:00Z`) -
              Date.parse(`${selectedDate}T00:00:00Z`)) / 86_400_000);
            const newMasterDate = toDateOnly(addDays(new Date(`${masterDate}T00:00:00`), dayDelta));
            if (input.all_day) {
              const durationDays = Math.max(1, Math.round((Date.parse(`${input.end}T00:00:00Z`) -
                Date.parse(`${input.start}T00:00:00Z`)) / 86_400_000));
              patch.start = { date: newMasterDate, dateTime: null, timeZone: null };
              patch.end = { date: toDateOnly(addDays(new Date(`${newMasterDate}T00:00:00`), durationDays)),
                dateTime: null, timeZone: null };
            } else {
              const tz =
                master?.start?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
              const t = new Date(input.start);
              const dur = new Date(input.end).getTime() - t.getTime();
              const ns = new Date(`${newMasterDate}T00:00:00`);
              ns.setHours(t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds());
              patch.start = { dateTime: toLocalISO(ns), timeZone: tz, date: null };
              patch.end = { dateTime: toLocalISO(new Date(ns.getTime() + dur)), timeZone: tz, date: null };
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
          showToast(`Updated all “${ev.summary}” events`, false);
        } else if (rrule) {
          // split: truncate the old series, start a new one at this instance
          let nextRule = rrule;
          const count = Number(rrule.match(/(?:^|;)COUNT=(\d+)/)?.[1] ?? 0);
          const countSplit = count ? {
            originalRecurrence: rrule,
            selectedOriginalStart: ev.raw?.originalStartTime ??
              (ev.all_day ? { date: ev.start } : { dateTime: ev.start }),
          } : undefined;
          // truncate + new series as one backend step: done as two calls,
          // a sync pass between them pulled the old series' cancelled tail
          // before the new series existed, and the rest of the series
          // vanished from view until the next pass.
          const splitInput = reminderSafeUpdate(ev, input);
          await backend.splitSeries(ev.calendar_id, masterId, [truncateRule(rrule, selectedOriginal, ev.all_day)], {
            ...splitInput,
            description: splitDrill(input.description).body || null,
            recurrence: [nextRule],
          }, countSplit);
          showToast(`Updated “${input.summary}” and following`, false);
        }
        setPanel({ mode: "closed" });
      } catch (e) {
        showToast(`Series update failed: ${e}`, false);
      }
    },
    [pendingScope, backend],
  );

  const pan = useCallback(
    (deltaDays: number) => {
      if (view === "week") setPanDays((p) => p + deltaDays);
      else setAnchor((prev) => addDays(prev, deltaDays));
    },
    [view],
  );

  // stable, so the memoized sidebar skips the re-render on every swipe step
  const pickDate = useCallback(
    (d: Date) => {
      setPanDays(0);
      setAnchor(d);
      if (view === "month") setView("week");
    },
    [view],
  );

  const toggleWeekends = useCallback(() => {
    if (view === "week") {
      const week = weekDays(anchor);
      if (hideWeekends) {
        setPanDays(Math.round((range.days[0].getTime() - week[0].getTime()) / 86_400_000));
      } else {
        const firstWeekday = range.days.find((d) => d.getDay() !== 0 && d.getDay() !== 6)!;
        const baseWeekday = week.find((d) => d.getDay() !== 0 && d.getDay() !== 6)!;
        setPanDays(businessDaysBetween(baseWeekday, firstWeekday));
      }
    }
    setHideWeekends(!hideWeekends);
  }, [anchor, hideWeekends, range.days, view]);

  const enterReconMode = useCallback(
    (queue: CalendarEvent[]) => {
      if (queue.length === 0) {
        showToast("Nothing to reconcile — all caught up", false);
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
      if (action === "canceled") setRecon(reconKey(target), "canceled");
      if (action === "deleted") void actions.removeOccurrence(target);
      const idx = m.idx + 1;
      if (idx >= m.queue.length) {
        showToast("Reconciled — day squared away", false);
        setSelected([]);
        setReconMode(null);
        return;
      }
      setSelected([m.queue[idx]]);
      setReconMode({ ...m, idx });
    },
    [actions],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      setPanDays(0);
      setAnchor((a) => {
        if (view === "day") return addDays(a, dir * dayCount);
        if (view === "week") return addWeeks(a, dir);
        if (view === "list") return addWeeks(a, dir * 2);
        return addMonths(a, dir);
      });
    },
    [view, dayCount],
  );

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
  const anyOverlay = panel.mode !== "closed" || quickOpen || cmdOpen;

  const sortedVisible = useMemo(
    () =>
      [...visible].sort((a, b) =>
        eventDates(a).start.getTime() - eventDates(b).start.getTime(),
      ),
    [visible],
  );

  const clipboardOp = useCallback(
    (ev: CalendarEvent, cut: boolean) => {
      clipboardRef.current = [inputOf(ev)];
      if (cut) {
        bulkRemove([ev]);
      } else {
        showToast(`Copied “${ev.summary}”`, false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bulkRemove],
  );

  const cycleSelection = useCallback(
    (dir: 1 | -1) => {
      if (sortedVisible.length === 0) return;
      const cur = selected[selected.length - 1] ?? null;
      const idx = cur
        ? sortedVisible.findIndex((e) => e.id === cur.id && e.calendar_id === cur.calendar_id)
        : -1;
      const next =
        sortedVisible[(idx + dir + sortedVisible.length) % sortedVisible.length] ??
        sortedVisible[0];
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

  // keyboard shortcuts (Notion/Google parity)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      // ignore global shortcuts while a grid drag is in progress (Esc is
      // handled by the drag itself)
      if (document.body.dataset.dragging) return;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
        return;
      }
      if (reconMode && !typing) {
        const k = e.key.toLowerCase();
        if (k === "y") { e.preventDefault(); reconAdvance("done"); return; }
        if (k === "x") { e.preventDefault(); reconAdvance("deleted"); return; }
        if (k === "c") { e.preventDefault(); reconAdvance("canceled"); return; }
        if (k === "s" || e.key === " ") { e.preventDefault(); reconAdvance("skip"); return; }
        if (k === "m") { e.preventDefault(); reconAdvance("open"); return; }
        if (e.key === "Escape") { e.preventDefault(); reconAdvance("exit"); return; }
      }
      // Escape works even while typing (closes the editor, like Google/Notion)
      if (e.key === "Escape") {
        if (anyOverlay) {
          setPanel({ mode: "closed" });
          setQuickOpen(false);
          setCmdOpen(false);
        } else {
          setSelected([]);
          dismissToast();
        }
        return;
      }
      if (typing) return;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoLast();
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
      if (mod && e.shiftKey && e.key === "0") {
        e.preventDefault();
        setHourPx(48);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        toggleWeekends();
        return;
      }
      if (mod && e.key.toLowerCase() === "a" && !anyOverlay) {
        e.preventDefault();
        setSelected(sortedVisible);
        showToast(`Selected ${sortedVisible.length} events`, false);
        return;
      }
      if (mod && e.key.toLowerCase() === "c" && selected.length > 0) {
        e.preventDefault();
        clipboardRef.current = selected.map(inputOf);
        showToast(
          selected.length === 1 ? `Copied “${selected[0].summary}”` : `Copied ${selected.length} events`,
          false,
        );
        return;
      }
      if (mod && e.key.toLowerCase() === "x" && selected.length > 0) {
        e.preventDefault();
        clipboardRef.current = selected.map(inputOf);
        bulkRemove(selected);
        return;
      }
      if (mod && e.key.toLowerCase() === "v" && clipboardRef.current?.length) {
        e.preventDefault();
        // a copied event from someone else's calendar pastes into yours
        const mine =
          calendars.find((k) => calendarEditable(k) && k.is_primary) ?? calendars.find((k) => calendarEditable(k));
        for (const c0 of clipboardRef.current) {
          const c = calendarEditable(calOf(c0.calendar_id)) || !mine ? c0 : { ...c0, calendar_id: mine.id };
          if (c.all_day) {
            const d = toDateOnly(anchor);
            const d2 = toDateOnly(addDays(startOfDay(anchor), 1));
            actions.create({ ...c, start: d, end: d2 });
          } else {
            // paste keeps the copied time-of-day on the anchored date
            const src = new Date(c.start);
            const dur = new Date(c.end).getTime() - src.getTime();
            const start = new Date(startOfDay(anchor));
            start.setHours(src.getHours(), src.getMinutes(), 0, 0);
            actions.create({
              ...c,
              start: toLocalISO(start),
              end: toLocalISO(new Date(start.getTime() + dur)),
            });
          }
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "d" && selected.length > 0) {
        e.preventDefault();
        if (selected.length === 1) actions.duplicate(selected[0]);
        else bulkDuplicate(selected);
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        const nowT = now().getTime();
        const target_ =
          (selectedOne?.conference_url ? selectedOne : null) ??
          sortedVisible.find(
            (ev) => ev.conference_url && eventDates(ev).end.getTime() >= nowT,
          );
        if (target_?.conference_url) openExternal(target_.conference_url);
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
          break;
        case "d":
        case "1":
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
          setDayCount(Number(e.key));
          setView("day");
          break;
        case "e":
          if (selectedOne) openEvent(selectedOne);
          break;
        case "x": {
          // Notion: select/deselect the highlighted (hovered) event
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
          setView("month");
          break;
        case "l":
          setView("list");
          break;
        case "r":
          enterReconMode(unreconciled(visible, calendars, now()));
          return;
        case "g":
          setSpotlight((s) => !s);
          return;
        case "i":
          setView("insights");
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
          cycleSelection(-1);
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
          if (selected.length > 0) {
            e.preventDefault();
            bulkRemove(selected);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, anyOverlay, selected, selectedOne, actions, cycleSelection, sortedVisible, openEvent, bulkRemove, bulkDuplicate, toggleSelect, toggleWeekends, calendars, calOf, panel, quickOpen, cmdOpen, pendingScope]);

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

  const connect = async () => {
    if (!backend) return;
    setConnecting(true);
    try {
      await backend.connectGoogle();
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
          anchor={anchor}
          authed={authed}
          events={visible}
          onPickDate={pickDate}
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
            rangeEnd={range.days.length > 0 ? range.days[range.days.length - 1] : undefined}
            view={view}
            dayCount={dayCount}
            authed={authed}
            connecting={connecting}
            onConnect={connect}
            onViewChange={setView}
            onDayCount={setDayCount}
            seamStyle={seamStyle}
            onSeamStyle={setSeamStyle}
            spotlight={spotlight}
            onSpotlight={() => setSpotlight((s) => !s)}
            onToday={() => { setPanDays(0); setAnchor(now()); }}
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
                setAnchor(d);
                setView("day");
              }}
              onDraftDay={(d) => {
                openDraft({ start: d, end: addDays(d, 1), allDay: true });
              }}
            />
          )}
          {view === "list" && (
            <AgendaView
              anchor={anchor}
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
            actions={actions}
            onClose={() => setQuickOpen(false)}
          />
        )}
        {cmdOpen && (
          <CommandMenu
            backend={backend}
            calendars={calendars}
            onClose={() => setCmdOpen(false)}
            onGoto={(d) => { setPanDays(0); setAnchor(d); }}
            onView={setView}
            onToday={() => { setPanDays(0); setAnchor(now()); }}
            onNewEvent={quickDraft}
            onOpenEvent={openEvent}
            secondaryTz={secondaryTz}
            onSecondaryTz={setSecondaryTz}
          />
        )}

        {pendingScope && (
          <ScopeDialog
            pending={pendingScope}
            onPick={applyScope}
            onCancel={() => setPendingScope(null)}
          />
        )}
        {reconMode && (
          <div className="recon-pill" data-testid="recon-pill">
            <span>
              Reconcile: <b>{reconMode.queue[reconMode.idx].summary}</b>
            </span>
            <span className="recon-count">
              {reconMode.idx + 1}/{reconMode.queue.length}
            </span>
            <span className="recon-keys">
              <button className="btn" onClick={() => reconAdvance("done")} data-testid="recon-btn-yes">
                ✓ Happened <kbd>Y</kbd>
              </button>
              <button className="btn" onClick={() => reconAdvance("canceled")} data-testid="recon-btn-canceled">
                ⊘ Canceled <kbd>C</kbd>
              </button>
              <button
                className="btn"
                onClick={() => reconAdvance("deleted")}
                data-testid="recon-btn-no"
                title="Didn't happen: deletes the event (⌘Z to undo)"
              >
                ✕ Didn't happen <kbd>X</kbd>
              </button>
              <button className="btn" onClick={() => reconAdvance("skip")}>
                Skip <kbd>S</kbd>
              </button>
              <button className="btn" onClick={() => reconAdvance("open")}>
                Open <kbd>M</kbd>
              </button>
              <button className="btn btn-ghost" onClick={() => reconAdvance("exit")}>
                Done <kbd>Esc</kbd>
              </button>
            </span>
          </div>
        )}
        {!reconMode && !sweepDismissed && (() => {
          const y0 = startOfDay(addDays(now(), -1));
          const q = unreconciled(visible, calendars, now(), { from: y0, to: startOfDay(now()) });
          if (q.length === 0) return null;
          const dismiss = () => {
            setSweepDismissed(true);
            try {
              localStorage.setItem("sweepDismissed", toDateOnly(now()));
            } catch {
              /* per-viewer convenience */
            }
          };
          return (
            <div className="recon-pill" data-testid="sweep-banner">
              <span>
                Yesterday: <b>{q.length} unconfirmed</b> event{q.length > 1 ? "s" : ""}
              </span>
              <button
                className="btn"
                onClick={() => {
                  q.forEach((e) => setRecon(reconKey(e), "done"));
                  dismiss();
                  showToast("Confirmed yesterday's events", false);
                }}
              >
                Confirm all
              </button>
              <button
                className="btn"
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
