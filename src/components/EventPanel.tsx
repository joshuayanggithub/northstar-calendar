// Docked event editor matching Notion Calendar's sidebar row-for-row:
// [Event ⌄  ⋯ ✕] · Title · 🕐 start → end (dur) · pretty date ·
// All-day / Time zone / Repeat · 👤 Participants · 📹 Conferencing ·
// 📍 Location · ─ Description ─ · ⬛ Calendar · Busy/Visibility · 🔔 Reminders.
// Enter / ⌘Enter saves, Esc dismisses.

import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { eventDates, format, toDateOnly, toLocalISO, fmtTimeShort, now } from "../lib/dates";
import { reconExempt, reconKey, reconState, setRecon, subscribeRecon } from "../lib/recon";
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

function durationLabel(startTime: string, endTime: string, nextDay: boolean): string {
  let mins = tMin(endTime) - tMin(startTime) + (nextDay ? 1440 : 0);
  if (mins <= 0) mins += 30;
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

const REMINDER_CHOICES: [string, number | null][] = [
  ["Default reminder", null],
  ["At time of event", 0],
  ["10 min before", 10],
  ["30 min before", 30],
  ["1 hour before", 60],
  ["1 day before", 1440],
];

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
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
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
  onPick: (v: string) => void;
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
        sub: props.relativeTo ? durationLabel(props.relativeTo, tStr(m), base + i * 15 >= 1440) : undefined,
      });
    }
    return out;
  }, [props.relativeTo]);
  useEffect(() => {
    if (!open || !listRef.current) return;
    const idx = opts.findIndex((o: { v: string }) => tMin(o.v) >= tMin(props.value));
    const el = listRef.current.children[Math.max(0, idx)] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "center" });
  }, [open, opts, props.value]);
  return (
    <span className="timefield">
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
        <div className="time-pop" ref={listRef} data-testid="time-pop">
          {opts.map((o) => (
            <button
              key={o.v}
              className={"time-opt" + (o.v === props.value ? " active" : "")}
              onPointerDown={(e) => {
                e.preventDefault();
                props.onPick(o.v);
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

/** A textarea as tall as its text (never shorter than `rows`): a long
 *  description reads in full, the panel scrolls instead of the box. It
 *  re-fits when the panel is resized, since the lines re-wrap. */
function GrowingTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
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
}) {
  const { state, calendars } = props;
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [allDayEnd, setAllDayEnd] = useState(""); // last covered day (inclusive)
  const [dateEditing, setDateEditing] = useState(false);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [allDay, setAllDay] = useState(false);
  const [endNextDay, setEndNextDay] = useState(false);
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
  const [, starTick] = useState(0);
  useEffect(() => subscribeStars(() => starTick((n) => n + 1)), []);
  useEffect(() => subscribeRecon(() => starTick((n) => n + 1)), []);
  const goals = useGoals(props.backend);
  const goalOptions = useMemo(() => goals.file.goals.map((g) => g.text), [goals.file]);
  const [error, setError] = useState<string | null>(null);
  const dateRef = useRef<HTMLInputElement | null>(null);
  const defaultCalendarId =
    calendars.find((c) => c.is_primary && calendarEditable(c))?.id ?? calendars.find(calendarEditable)?.id ?? "";
  const [copyOpen, setCopyOpen] = useState(false);
  const openKey = state.mode === "view" ? `${state.event.calendar_id}/${state.event.id}` : state.mode;
  useEffect(() => setCopyOpen(false), [openKey]);

  useEffect(() => {
    setBusy(false);
    setError(null);
    setWithMeet(false);
    setMenuOpen(false);
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
        e.all_day ? toDateOnly(new Date(end.getTime() - 86400000)) : toDateOnly(start),
      );
      setStartTime(format(start, "HH:mm"));
      setEndTime(format(end, "HH:mm"));
      setEndNextDay(!e.all_day && toDateOnly(end) !== toDateOnly(start));
      setAllDay(e.all_day);
      setCalendarId(e.calendar_id);
      setLocation(e.location ?? "");
      setLocCoords(null);
      locPicked.current = e.location ?? null;
      {
        const parts = splitDrill(e.description);
        setDescription(parts.body);
        // as the margin shows it: without the model's stage directions
        setDrill(cleanDrill(parts.drill, e.summary));
      }
      const raw = e.raw ?? {};
      setAttendees((raw.attendees ?? []).map((a: any) => a.email).filter(Boolean));
      setTransparency(raw.transparency ?? "opaque");
      setVisibility(raw.visibility ?? "default");
      const ov = raw.reminders?.useDefault === false ? raw.reminders?.overrides?.[0]?.minutes : null;
      setReminderMin(typeof ov === "number" ? ov : null);
    } else if (state.mode === "new") {
      const d = state.draft;
      setTitle("");
      setEndNextDay(!d.allDay && toDateOnly(d.end) !== toDateOnly(d.start));
      setDate(toDateOnly(d.start));
      setAllDayEnd(
        d.allDay ? toDateOnly(new Date(d.end.getTime() - 86400000)) : toDateOnly(d.start),
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
      setTransparency("opaque");
      setVisibility("default");
      setReminderMin(null);
    }
  // Not `calendars`: every db change (a note saved, a sync pass) refetches
  // the list as a new array, and resetting on that put the opened snapshot
  // back into every field: the erased note reappeared and the panel flashed.
  }, [state, defaultCalendarId]);

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
    if (!checked && startTime === "00:00" && endTime === "00:00") {
      setStartTime("09:00");
      setEndTime("10:00");
      setEndNextDay(false);
    }
  };

  const addAttendee = () => {
    const v = attendeeInput.trim().replace(/,$/, "");
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !attendees.includes(v)) {
      setAttendees((a) => [...a, v]);
    }
    setAttendeeInput("");
  };

  const buildInput = (): EventInput => {
    const start = allDay ? date : toLocalISO(new Date(`${date}T${startTime}:00`));
    let end: string;
    if (allDay) {
      const last = allDayEnd && allDayEnd > date ? allDayEnd : date;
      const d = new Date(`${last}T00:00:00`);
      d.setDate(d.getDate() + 1);
      end = toDateOnly(d);
    } else {
      let endD = new Date(`${date}T${endTime}:00`);
      const startD = new Date(`${date}T${startTime}:00`);
      if (endNextDay) {
        endD = new Date(endD.getTime() + 86400000);
      } else if (endD <= startD) {
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
      attendees: attendees.length > 0 ? attendees : state.mode === "view" ? [] : undefined,
      transparency,
      visibility,
      reminder_minutes: reminderMin,
    };
  };

  const save = async () => {
    if (!props.backend || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      if (state.mode === "new") {
        await props.actions.create(buildInput());
      } else {
        await props.actions.update(state.event, buildInput());
      }
      props.onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!props.backend || state.mode !== "view") return;
    setBusy(true);
    try {
      await props.actions.remove(state.event);
      props.onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      // the panel stays mounted between events: a busy flag left on here
      // disabled Save and Delete on every event opened after a delete
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
  const rsvpOf = (email: string): string =>
    state.mode === "view"
      ? ((state.event.raw?.attendees ?? []).find((a: any) => a.email === email)?.responseStatus ?? "")
      : "";

  const prettyDate = date ? format(new Date(`${date}T00:00:00`), "EEE, MMM d") : "";

  return (
    <aside
      className="event-panel"
      data-testid="event-panel"
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName !== "TEXTAREA")
        ) {
          if ((e.target as HTMLElement).classList.contains("panel-attendee-input")) return;
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
            <button className="ctx-danger" onClick={remove}>
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
                  const dur = Math.max(15, tMin(endTime) - tMin(startTime));
                  setEndTime(tStr(tMin(v) + dur));
                  setStartTime(v);
                }}
              />
              <span className="panel-arrow">→</span>
              <TimeField
                value={endTime}
                disabled={readOnly}
                relativeTo={startTime}
                testid="time-end"
                onPick={(v) => setEndTime(v)}
              />
              <span className="panel-dur">
                {endNextDay && <span className="panel-nextday">+1d</span>}
                {durationLabel(startTime, endTime, endNextDay)}
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
              onChange={(e) => setDate(e.target.value)}
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
          {attendees.length > 0 && (
            <div className="panel-attendees">
              {attendees.map((a) => (
                <span key={a} className={"panel-attendee rsvp-" + (rsvpOf(a) || "none")}>
                  {a}
                  {!readOnly && (
                    <button
                      aria-label={`Remove ${a}`}
                      onClick={() => setAttendees((list) => list.filter((x) => x !== a))}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {!readOnly && (
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
            <span className="panel-icon">✓</span>
            <div className="panel-section-body panel-recon-body">
              {(() => {
                const key = reconKey(state.event);
                const st = reconState(state.event, calendars, now());
                return (
                  <>
                    <div className="recon-seg" role="group" aria-label="Did this happen?">
                      <button
                        className={"recon-seg-btn yes" + (st === "done" ? " active" : "")}
                        data-testid="panel-recon-yes"
                        onClick={() => setRecon(key, st === "done" ? null : "done")}
                      >
                        <span className="recon-seg-ic">✓</span> Happened
                      </button>
                      <button
                        className={"recon-seg-btn canceled" + (st === "canceled" ? " active" : "")}
                        data-testid="panel-recon-canceled"
                        title="Canceled: skipped, but stays on the calendar (struck through)"
                        onClick={() => setRecon(key, st === "canceled" ? null : "canceled")}
                      >
                        <span className="recon-seg-ic">⊘</span> Canceled
                      </button>
                      <button
                        className="recon-seg-btn no"
                        data-testid="panel-recon-no"
                        title="Didn't happen: deletes the event (⌘Z to undo)"
                        onClick={() => void props.actions.removeOccurrence(state.event)}
                      >
                        <span className="recon-seg-ic">✕</span> Didn't
                      </button>
                      <button
                        className="recon-seg-btn"
                        data-testid="panel-recon-move"
                        title="It happened, but at a different time — adjust the times and save"
                        aria-label="Happened at a different time"
                        onClick={(ev) => {
                          setRecon(key, "done");
                          const panel = (ev.currentTarget as HTMLElement).closest(
                            "[data-testid=event-panel]",
                          );
                          (panel?.querySelector("[data-testid=time-start]") as HTMLElement | null)?.focus();
                        }}
                      >
                        <span className="recon-seg-ic">↷</span>
                      </button>
                    </div>
                    {st === "unsettled" && <span className="recon-hint">unconfirmed</span>}
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
          <span className="panel-icon panel-star-icon">★</span>
          <div className="panel-section-body">
            <select
              className="panel-plain panel-goal"
              data-testid="goal-link"
              value={(() => {
                const st = starState(starKey(state.event));
                if (!st) return "";
                if (st.kind === "auto") return "__auto";
                return st.goal ?? "__starred";
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
      {state.mode === "view" && (
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
              <span className="panel-cal-chevron" aria-hidden="true">⌄</span>
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
          </select>
        </div>
      </div>

      {error && <div className="panel-error">{error}</div>}

      <div className="panel-footer">
        {state.mode === "view" && !readOnly && (
          <button className="btn btn-danger" onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <span className="panel-spacer" />
        {!readOnly && (
          <button className="btn btn-accent" onClick={save} disabled={busy}>
            {state.mode === "new" ? "Create" : "Save"} <kbd>↩</kbd>
          </button>
        )}
      </div>
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
  const start = () => {
    if (!props.editable) return;
    cancelled.current = false;
    setEditing(true);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
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
