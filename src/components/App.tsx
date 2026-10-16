import { useCallback, useEffect, useMemo, useState } from "react";
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
import { CommandMenu } from "./CommandMenu";

export type View = "day" | "week" | "month" | "list" | "insights";

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
      const next = sel.map((s) => {
        const cur = visible.find((e) => e.id === s.id && e.calendar_id === s.calendar_id);
        if (cur && cur !== s) {
          changed = true;
          return cur;
        }
        return s;
      });
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
          askScope({ kind: "edit", event: ev, input, label, canSplit: !input.all_day && !ev.all_day });
          return;
        }
        const prev = inputOf(ev);
        await backend.updateEvent(ev.id, input, ev.calendar_id);
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
        const snapshot = inputOf(ev);
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
        const snapshot = inputOf(ev);
        await backend.deleteEvent(ev.calendar_id, ev.id);
        setPanel((p) =>
          p.mode === "view" && p.event.id === ev.id && p.event.calendar_id === ev.calendar_id
            ? { mode: "closed" }
            : p,
        );
        setSelected((sel) => sel.filter((s) => !(s.id === ev.id && s.calendar_id === ev.calendar_id)));
        recordUndo(`Didn't happen — deleted “${ev.summary}”`, async () => {
          await backend.createEvent(snapshot);
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
      const snapshots = editable.map(inputOf);
      await Promise.all(editable.map((e) => backend.deleteEvent(e.calendar_id, e.id)));
      setSelected([]);
      setPanel((p) =>
        p.mode === "view" && editable.some((e) => keyOfEv(e) === keyOfEv(p.event))
          ? { mode: "closed" }
          : p,
      );
      recordUndo(
        `Deleted ${editable.length} events${skipped ? ` (${skipped} read-only skipped)` : ""}`,
        async () => {
          await Promise.all(snapshots.map((snap) => backend.createEvent(snap)));
        },
      );
    },
    [backend, actions, isReadOnly],
  );

  const bulkDuplicate = useCallback(
    async (evs: CalendarEvent[]) => {
      if (!backend) return;
      const ids: { cal: string; id: string }[] = [];
      for (const ev of evs) {
        const input = inputOf(ev);
        if (isReadOnly(ev)) {
          const target =
            calendars.find((c) => calendarEditable(c) && c.is_primary) ??
            calendars.find((c) => calendarEditable(c));
          if (!target) continue;
          input.calendar_id = target.id;
        }
        const id = await backend.createEvent(input);
        if (id) ids.push({ cal: input.calendar_id, id });
      }
      recordUndo(`Duplicated ${ids.length} events`, async () => {
        await Promise.all(ids.map(({ cal, id }) => backend.deleteEvent(cal, id)));
      });
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
      await Promise.all(
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
      const left = selected.length - movable.length;
      recordUndo(
        `Moved ${movable.length} events` + (left ? ` (${left} read-only or all-day stayed)` : ""),
        async () => {
          await Promise.all(prevs.map(([e, prev]) => backend.updateEvent(e.id, prev, e.calendar_id)));
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
      const rrule: string | undefined = master?.recurrence?.find((r: string) =>
        r.startsWith("RRULE"),
      );
      const untilOf = (boundaryIso: string) => {
        const u = new Date(new Date(boundaryIso).getTime() - 1000);
        const pad = (n: number) => String(n).padStart(2, "0");
        return (
          `${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}` +
          `T${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}${pad(u.getUTCSeconds())}Z`
        );
      };
      const truncateRule = (rule: string, boundaryIso: string) => {
        const until = `UNTIL=${untilOf(boundaryIso)}`;
        const withoutEnd = rule.replace(/;COUNT=\d+/, "").replace(/;UNTIL=[^;]+/, "");
        return `${withoutEnd};${until}`;
      };
      try {
        if (p.kind === "delete") {
          if (effectiveScope === "this") {
            const snapshot = inputOf(ev);
            await backend.deleteEvent(ev.calendar_id, ev.id);
            recordUndo(`Deleted “${ev.summary}”`, async () => {
              await backend.createEvent(snapshot);
            });
          } else if (effectiveScope === "all") {
            await backend.deleteEvent(ev.calendar_id, masterId);
            showToast(`Deleted series “${ev.summary}”`, false);
          } else if (rrule) {
            await backend.updateSeriesMaster(ev.calendar_id, masterId, {
              recurrence: [truncateRule(rrule, selectedOriginal)],
            });
            showToast(`Deleted “${ev.summary}” and following`, false);
          }
          setSelected([]);
          setPanel({ mode: "closed" });
          return;
        }
        const input = p.input!;
        if (effectiveScope === "this") {
          const prev = inputOf(ev);
          await backend.updateEvent(ev.id, input, ev.calendar_id);
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
          if (input.attendees) {
            const prior = (ev.raw?.attendees ?? []) as { email: string }[];
            const emails = (values: string[]) => [...values].map((email) => email.toLowerCase()).sort().join("\n");
            if (emails(input.attendees) !== emails(prior.map((attendee) => attendee.email))) {
              patch.attendees = input.attendees.map((email) =>
                prior.find((attendee) => attendee.email.toLowerCase() === email.toLowerCase()) ?? { email });
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
          );
          showToast(`Updated all “${ev.summary}” events`, false);
        } else if (rrule) {
          // split: truncate the old series, start a new one at this instance
          let nextRule = rrule;
          const count = Number(rrule.match(/(?:^|;)COUNT=(\d+)/)?.[1] ?? 0);
          if (count) {
            const instances = await backend.getSeriesInstances(ev.calendar_id, masterId);
            const originalTime = (instance: any) => {
              const value = instance.originalStartTime?.dateTime ?? instance.originalStartTime?.date;
              return value?.length === 10 ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
            };
            const selectedOriginal = ev.raw?.originalStartTime ??
              (ev.all_day ? { date: ev.start } : { dateTime: ev.start });
            const boundary = originalTime({ originalStartTime: selectedOriginal });
            if (!Number.isFinite(boundary) || !instances.some((instance: any) => instance.id === ev.id)) {
              throw new Error("could not locate this occurrence in the series");
            }
            const earlier = instances.filter((instance: any) => originalTime(instance) < boundary).length;
            const remaining = count - earlier;
            if (remaining < 1) throw new Error("no occurrences remain after this event");
            nextRule = rrule.replace(/COUNT=\d+/, `COUNT=${remaining}`);
          }
          // truncate + new series as one backend step: done as two calls,
          // a sync pass between them pulled the old series' cancelled tail
          // before the new series existed, and the rest of the series
          // vanished from view until the next pass.
          await backend.splitSeries(ev.calendar_id, masterId, [truncateRule(rrule, selectedOriginal)], {
            ...input,
            description: splitDrill(input.description).body || null,
            recurrence: [nextRule],
          });
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
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
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
  }, [step, anyOverlay, selected, selectedOne, actions, cycleSelection, sortedVisible, openEvent, bulkRemove, bulkDuplicate, toggleSelect, toggleWeekends, calendars, calOf]);

  // Clicking outside the open editor dismisses it; the grid stays live
  // (clicking another chip switches panels directly) — Google behavior.
  useEffect(() => {
    if (panel.mode === "closed") return;
    const onDown = (ev: PointerEvent) => {
      const el = document.querySelector(".event-panel");
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
    <BackendContext.Provider value={backend}>
      <div className={"app" + (sidebarHidden ? " sidebar-hidden" : "")}>
        <Sidebar
          backend={backend}
          calendars={calendars}
          anchor={anchor}
          authed={authed}
          events={visible}
          onPickDate={pickDate}
        />
        <div className="main">
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
  );
}
