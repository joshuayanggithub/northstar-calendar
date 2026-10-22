import { memo, useEffect, useMemo, useState } from "react";
import {
  addMonths,
  format,
  isSameDay,
  isSameMonth,
  monthGrid,
  now,
} from "../lib/dates";
import { calendarEditable } from "../lib/types";
import type { Backend, Calendar } from "../lib/types";
import { runningInTauri } from "../lib/backend";
import { PICKS } from "../lib/color";
import { colorOf } from "../lib/useBackend";
import { getPrefs, setPrefs } from "../lib/settings";
import { HORIZONS, useGoals, type Horizon } from "../lib/goals";
import { starKey, starsForGoal, subscribeStars } from "../lib/stars";
import { GrowingTextarea } from "./EventPanel";
import type { CalendarEvent } from "../lib/types";

function MiniMonth(props: { anchor: Date; onPick: (d: Date) => void }) {
  const [shown, setShown] = useState(() => props.anchor);
  // follow the main view when it navigates (Notion behavior), also when it
  // stays in the same month (Today after paging the mini-month away)
  useEffect(() => {
    setShown(props.anchor);
  }, [props.anchor]);
  const weeks = useMemo(() => monthGrid(shown), [shown]);
  const today = now();
  return (
    <div className="mini-month" data-testid="mini-month">
      <div className="mini-head">
        <span className="mini-title">{format(shown, "MMMM yyyy")}</span>
        <span className="mini-nav">
          <button aria-label="Previous month" onClick={() => setShown((d) => addMonths(d, -1))}>
            ‹
          </button>
          <button aria-label="Next month" onClick={() => setShown((d) => addMonths(d, 1))}>
            ›
          </button>
        </span>
      </div>
      <div className="mini-grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i} className="mini-dow">
            {d}
          </span>
        ))}
        {weeks.flat().map((d) => (
          <button
            key={d.toISOString()}
            className={
              "mini-day" +
              (isSameMonth(d, shown) ? "" : " out") +
              (isSameDay(d, today) ? " today" : "") +
              (isSameDay(d, props.anchor) ? " selected" : "")
            }
            onClick={() => props.onPick(d)}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Goals, daily / weekly / long-term, kept by the app (lib/goals.ts). Laid
 *  out like the calendar lists above it: a section head with ＋, a
 *  collapsible group per horizon with its tally, one row per goal (a tick
 *  where a calendar has its color dot). Double-click a goal to rename it;
 *  emptying the text deletes it. */
function GoalsSection(props: {
  backend: Backend | null;
  events?: CalendarEvent[];
}) {
  const goals = useGoals(props.backend);
  const [, starTick] = useState(0);
  useEffect(() => subscribeStars(() => starTick((n) => n + 1)), []);
  const starBadge = (goalText: string) => {
    const { manual, auto } = starsForGoal(goalText);
    if (manual.length === 0 && auto.length === 0) return null;
    const nameOf = (k: string) =>
      props.events?.find((e) => starKey(e) === k)?.summary;
    const names = [
      ...manual.map((k) => nameOf(k)).filter(Boolean).map((n) => `★ ${n}`),
      ...auto.map((k) => nameOf(k)).filter(Boolean).map((n) => `☆ ${n} (suggested)`),
    ];
    return (
      <span
        className="goal-star-count"
        title={names.length ? names.join("\n") : `${manual.length + auto.length} event(s)`}
      >
        {manual.length > 0 && <>★ {manual.length}</>}
        {auto.length > 0 && <span className="goal-star-auto">☆ {auto.length}</span>}
      </span>
    );
  };
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      // (a corrupt value blanked the window)
      const v = JSON.parse(localStorage.getItem("goals-collapsed") ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  });
  const toggleGroup = (key: Horizon | "section") =>
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try {
        localStorage.setItem("goals-collapsed", JSON.stringify(next));
      } catch {
        /* per-viewer convenience only */
      }
      return next;
    });
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const [addTo, setAddTo] = useState<Horizon>("daily");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const submitAdd = () => {
    const v = addText.trim();
    if (!v) return;
    goals.add(addTo, v);
    setAddText("");
    if (collapsed[addTo]) toggleGroup(addTo);
  };
  const commitEdit = () => {
    if (!editing) return;
    if (editing.text.trim()) goals.rename(editing.id, editing.text);
    else goals.remove(editing.id);
    setEditing(null);
  };

  return (
    <div className="sidebar-section goals" data-testid="goals-section">
      <div className="sidebar-head">
        <button
          className="sidebar-label sidebar-toggle"
          data-testid="goals-toggle"
          aria-expanded={!collapsed.section}
          onClick={() => toggleGroup("section")}
        >
          <span className={"goals-chevron" + (collapsed.section ? " closed" : "")}>▾</span>
          Goals
          {collapsed.section && goals.file.goals.length > 0 && (
            <span className="cal-group-count">
              {goals.file.goals.filter((g) => goals.isDone(g)).length}/{goals.file.goals.length}
            </span>
          )}
        </button>
        <span className="sidebar-head-actions">
          <button
            className="cal-add"
            title="New goal"
            aria-label="Add goal"
            data-testid="goal-add"
            onClick={() => {
              if (collapsed.section) toggleGroup("section");
              setAdding((a) => !a);
            }}
          >
            ＋
          </button>
        </span>
      </div>
      {adding && !collapsed.section && (
        <div className="cal-add-form" data-testid="goal-add-form">
          <input
            autoFocus
            placeholder="New goal"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitAdd();
              if (e.key === "Escape") { e.stopPropagation(); setAdding(false); }
            }}
          />
          <div className="goal-horizons" role="radiogroup" aria-label="Kind of goal">
            {HORIZONS.map((h) => (
              <button
                key={h.key}
                role="radio"
                aria-checked={addTo === h.key}
                className={"goal-horizon" + (addTo === h.key ? " on" : "")}
                onClick={() => setAddTo(h.key)}
              >
                {h.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!collapsed.section && HORIZONS.map((h) => {
        const list = goals.file.goals.filter((g) => g.horizon === h.key);
        const done = list.filter((g) => goals.isDone(g)).length;
        return (
          <div className="cal-group" data-testid={`goal-group-${h.key}`} key={h.key}>
            <button className="cal-group-head" onClick={() => toggleGroup(h.key)}>
              <span className={"goals-chevron" + (collapsed[h.key] ? " closed" : "")}>▾</span>
              {h.label}
              {list.length > 0 && (
                <span className="cal-group-count">
                  {done}/{list.length}
                </span>
              )}
            </button>
            {!collapsed[h.key] && (
              <ul className="cal-list">
                {list.length === 0 && (
                  <li className="goal-none">
                    <button
                      className="goal-row goal-empty"
                      onClick={() => {
                        setAddTo(h.key);
                        setAdding(true);
                      }}
                    >
                      Add a {h.key === "long" ? "long-term" : h.key} goal
                    </button>
                  </li>
                )}
                {list.map((g) => {
                  const on = goals.isDone(g);
                  return (
                    <li key={g.id}>
                      <div className={"goal-row" + (on ? " done" : "")} data-testid="goal-row">
                        <button
                          className="goal-tick"
                          role="checkbox"
                          aria-checked={on}
                          aria-label={on ? "Mark not done" : "Mark done"}
                          onClick={() => goals.toggle(g)}
                        >
                          {on ? "✓" : ""}
                        </button>
                        {editing?.id === g.id ? (
                          <input
                            className="goal-edit"
                            autoFocus
                            value={editing.text}
                            onChange={(e) => setEditing({ id: g.id, text: e.target.value })}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
                            }}
                          />
                        ) : (
                          <span
                            className="cal-name goal-text"
                            title={g.text}
                            onDoubleClick={() => setEditing({ id: g.id, text: g.text })}
                          >
                            {g.text}
                          </span>
                        )}
                        {starBadge(g.text)}
                        <button
                          className="goal-del"
                          title="Delete goal"
                          aria-label="Delete goal"
                          onClick={() => goals.remove(g.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The thought dump: bullet points of things to think about, under the
 *  goals and kept with them (lib/goals.ts). Type and press Enter to add one
 *  (the field stays ready for the next); double-click a line to edit it,
 *  emptying it deletes it; ✕ deletes. Collapsible like the sections above. */
function ThoughtsSection(props: { backend: Backend | null }) {
  const goals = useGoals(props.backend);
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem("thoughts-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setClosed((c) => {
      try {
        localStorage.setItem("thoughts-collapsed", c ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !c;
    });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const list = goals.thoughts;
  const commitEdit = () => {
    if (!editing) return;
    goals.editThought(editing.id, editing.text);
    setEditing(null);
  };
  return (
    <div className="sidebar-section thoughts" data-testid="thoughts-section">
      <div className="sidebar-head">
        <button
          className="sidebar-label sidebar-toggle"
          data-testid="thoughts-toggle"
          aria-expanded={!closed}
          onClick={toggle}
        >
          <span className={"goals-chevron" + (closed ? " closed" : "")}>▾</span>
          Thought dump
          {closed && list.length > 0 && <span className="cal-group-count">{list.length}</span>}
        </button>
      </div>
      {!closed && (
        <>
          <ul className="thought-list">
            {list.map((t) => (
              <li key={t.id} className="thought-row" data-testid="thought-row">
                <span className="thought-dot" aria-hidden="true">•</span>
                {editing?.id === t.id ? (
                  <GrowingTextarea
                    className="thought-edit"
                    autoFocus
                    rows={1}
                    // (the caret at the end, as the goal rename puts it)
                    onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
                    value={editing.text}
                    onChange={(e) => setEditing({ id: t.id, text: e.target.value })}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        commitEdit();
                      }
                      if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
                    }}
                  />
                ) : (
                  <span
                    className="thought-text"
                    title="Double-click to edit"
                    onDoubleClick={() => setEditing({ id: t.id, text: t.text })}
                  >
                    {t.text}
                  </span>
                )}
                <button
                  className="goal-del"
                  title="Delete"
                  aria-label="Delete thought"
                  onClick={() => goals.removeThought(t.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <input
            className="thought-add"
            data-testid="thought-add"
            placeholder={list.length ? "Add another…" : "Something to think about…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                goals.addThought(draft);
                setDraft("");
              }
              if (e.key === "Escape") { e.stopPropagation(); (e.target as HTMLInputElement).blur(); }
            }}
          />
        </>
      )}
    </div>
  );
}

// Memoized: App re-renders on every swipe step, but nothing the sidebar
// shows depends on the week view's pan offset.
/** one collator (a localeCompare with options builds one per call: ~5ms a
 *  render at 4x CPU on every navigation step) */
const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: "base" });

export const Sidebar = memo(function Sidebar(props: {
  /** today's date: a new day re-renders the (memoized) sidebar */
  today?: string;
  backend: Backend | null;
  calendars: Calendar[];
  anchor: Date;
  authed: boolean | null;
  accountEmail?: string;
  onPickDate: (d: Date) => void;
  events?: CalendarEvent[];
  /** the calendar shown on its own for now (right-click: Isolate) */
  isolated?: string | null;
  onIsolate?: (id: string | null) => void;
}) {
  const { calendars } = props;
  // right-click menu on a calendar
  const [calMenu, setCalMenu] = useState<{ x: number; y: number; cal: Calendar } | null>(null);
  useEffect(() => {
    if (!calMenu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setCalMenu(null);
      }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [calMenu]);
  const [adding, setAdding] = useState(false);
  const [calCollapsed, setCalCollapsed] = useState<{ my: boolean; other: boolean }>(() => {
    try {
      const v = JSON.parse(localStorage.getItem("cal-collapsed") ?? "null");
      return v && typeof v === "object" ? { my: !!v.my, other: !!v.other } : { my: false, other: false };
    } catch {
      return { my: false, other: false };
    }
  });
  const toggleCalGroup = (key: "my" | "other") =>
    setCalCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try {
        localStorage.setItem("cal-collapsed", JSON.stringify(next));
      } catch {
        /* per-viewer convenience only */
      }
      return next;
    });
  const [addText, setAddText] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);
  // Heuristic: calendar ids are email-ish; plain names create a new calendar.
  const looksLikeId = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addText.trim());

  // (one request at a time: a second Enter while Google answered made two
  // calendars)
  const [submitting, setSubmitting] = useState(false);
  const submitAdd = async () => {
    const v = addText.trim();
    if (!v || !props.backend || submitting) return;
    setAddErr(null);
    setSubmitting(true);
    try {
      await props.backend.addCalendar(v, looksLikeId);
      setAddText("");
      setAdding(false);
    } catch (e) {
      setAddErr(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside className="sidebar">
      <MiniMonth anchor={props.anchor} onPick={props.onPickDate} />
      <div className="sidebar-section">
        <div className="sidebar-head">
          <span className="sidebar-label">
            {/* the account: Google names the primary calendar after it */}
            {(props.authed && (props.accountEmail ?? calendars.find((c) => c.is_primary && c.id.includes("@"))?.id)) ||
              "Calendars"}
          </span>
          <button
            className="cal-add"
            title="New calendar or subscribe by ID"
            aria-label="Add calendar"
            onClick={() => {
              setAdding((a) => !a);
              setAddErr(null);
            }}
          >
            ＋
          </button>
        </div>
        {adding && (
          <div className="cal-add-form" data-testid="cal-add-form">
            <input
              autoFocus
              placeholder="Name, or calendar ID to subscribe"
              disabled={submitting}
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
                if (e.key === "Escape") { e.stopPropagation(); setAdding(false); }
              }}
            />
            <div className="cal-add-hint">
              {submitting
                ? "Creating…"
                : addText
                ? looksLikeId
                  ? "↵ subscribe to this calendar ID"
                  : "↵ create new calendar"
                : "e.g. “Side projects” or en.usa#holiday@group.v.calendar.google.com"}
            </div>
            {addErr && <div className="cal-add-err">{addErr}</div>}
          </div>
        )}
        {(() => {
          // Google Calendar's split: calendars you own/write vs subscriptions
          const byName = (a: Calendar, b: Calendar) =>
            Number(b.is_primary) - Number(a.is_primary) ||
            NAME_ORDER.compare(a.summary, b.summary);
          const mine = calendars.filter((c) => calendarEditable(c)).sort(byName);
          const other = calendars.filter((c) => !calendarEditable(c)).sort(byName);
          const renderGroup = (key: "my" | "other", label: string, list: Calendar[]) =>
            list.length === 0 ? null : (
              <div className="cal-group" data-testid={`cal-group-${key}`} key={key}>
                <button className="cal-group-head" onClick={() => toggleCalGroup(key)}>
                  <span className={"goals-chevron" + (calCollapsed[key] ? " closed" : "")}>▾</span>
                  {label}
                  {calCollapsed[key] && <span className="cal-group-count">{list.length}</span>}
                </button>
                {!calCollapsed[key] && (
                  <ul className="cal-list">
                    {list.map((c) => (
                      <li key={c.id}>
                        <button
                          className={
                            "cal-row" +
                            (props.isolated
                              ? c.id === props.isolated ? " isolated-cal" : " hidden-cal isolating"
                              : c.hidden ? " hidden-cal" : "")
                          }
                          data-testid="cal-row"
                          // while one is isolated, a click isolates this one instead
                          onClick={() =>
                            props.isolated
                              ? props.onIsolate?.(c.id === props.isolated ? null : c.id)
                              : props.backend?.setCalendarHidden(c.id, !c.hidden)
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setCalMenu({ x: e.clientX, y: e.clientY, cal: c });
                          }}
                          title={
                            props.isolated
                              ? c.id === props.isolated ? "Show all calendars" : "Show only this calendar"
                              : c.hidden ? "Show calendar" : "Hide calendar"
                          }
                        >
                          <span
                            className="cal-dot"
                            style={{ background: colorOf(calendars, c.id) }}
                          />
                          <span className="cal-name">{c.summary}</span>
                          {c.is_primary && <span className="cal-default">Default</span>}
                          <span className="cal-eye">
                            {props.isolated
                              ? c.id === props.isolated ? "Show all" : "Only"
                              : c.hidden ? "Show" : "Hide"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          return (
            <>
              {renderGroup("my", "My calendars", mine)}
              {renderGroup("other", "Other calendars", other)}
              {calendars.length === 0 && <div className="cal-empty">No calendars yet</div>}
            </>
          );
        })()}
      </div>
      {calMenu && (
        <div className="ctx-scrim" onPointerDown={() => setCalMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCalMenu(null); }}>
          <div
            className="ctx-menu"
            data-testid="cal-menu"
            style={{ left: Math.min(calMenu.x, window.innerWidth - 220), top: Math.min(calMenu.y, window.innerHeight - 190) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {props.isolated === calMenu.cal.id ? (
              <button onClick={() => { props.onIsolate?.(null); setCalMenu(null); }}>
                Show all calendars <kbd>Esc</kbd>
              </button>
            ) : (
              <button onClick={() => { props.onIsolate?.(calMenu.cal.id); setCalMenu(null); }}>
                Isolate calendar
              </button>
            )}
            {!props.isolated && (
              <button
                onClick={() => {
                  void props.backend?.setCalendarHidden(calMenu.cal.id, !calMenu.cal.hidden);
                  setCalMenu(null);
                }}
              >
                {calMenu.cal.hidden ? "Show calendar" : "Hide calendar"}
              </button>
            )}
            {/* this app's color for the calendar (Google's stays as it is) */}
            <div className="cal-menu-colors" data-testid="cal-colors" role="group" aria-label="Calendar color">
              {PICKS.map((p) => {
                const on = getPrefs().calColors[calMenu.cal.id] === p.hex;
                return (
                  <button
                    key={p.hex}
                    className={"cal-swatch" + (on ? " on" : "")}
                    title={p.name}
                    aria-label={p.name}
                    aria-pressed={on}
                    style={{ background: p.hex }}
                    onClick={() => {
                      setPrefs({ calColors: { ...getPrefs().calColors, [calMenu.cal.id]: p.hex } });
                      setCalMenu(null);
                    }}
                  />
                );
              })}
            </div>
            {getPrefs().calColors[calMenu.cal.id] && (
              <button
                data-testid="cal-color-reset"
                onClick={() => {
                  const { [calMenu.cal.id]: _gone, ...rest } = getPrefs().calColors;
                  setPrefs({ calColors: rest });
                  setCalMenu(null);
                }}
              >
                Use Google's color
              </button>
            )}
          </div>
        </div>
      )}
      <GoalsSection backend={props.backend} events={props.events} />
      <ThoughtsSection backend={props.backend} />
      {!runningInTauri && <div className="mock-badge">browser mock mode</div>}
    </aside>
  );
});
