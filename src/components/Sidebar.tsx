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
import { normalizeCalendarColor } from "../lib/color";
import { HORIZONS, useGoals, type Horizon } from "../lib/goals";
import { starsForGoal, subscribeStars } from "../lib/stars";
import type { CalendarEvent } from "../lib/types";

function MiniMonth(props: { anchor: Date; onPick: (d: Date) => void }) {
  const [shown, setShown] = useState(() => props.anchor);
  // follow the main view when it navigates (Notion behavior)
  useEffect(() => {
    setShown(props.anchor);
  }, [props.anchor.getFullYear(), props.anchor.getMonth()]); // eslint-disable-line react-hooks/exhaustive-deps
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
  onOpenReview: () => void;
  events?: CalendarEvent[];
}) {
  const goals = useGoals(props.backend);
  const [, starTick] = useState(0);
  useEffect(() => subscribeStars(() => starTick((n) => n + 1)), []);
  const starBadge = (goalText: string) => {
    const { manual, auto } = starsForGoal(goalText);
    if (manual.length === 0 && auto.length === 0) return null;
    const nameOf = (k: string) =>
      props.events?.find((e) => `${e.calendar_id}/${e.id}` === k)?.summary;
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
      return JSON.parse(localStorage.getItem("goals-collapsed") ?? "{}");
    } catch {
      return {};
    }
  });
  const toggleGroup = (key: Horizon) =>
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
        <span className="sidebar-label">Goals</span>
        <span className="sidebar-head-actions">
          <button className="cal-add" title="Weekly review" aria-label="Weekly review" onClick={props.onOpenReview}>
            ↗
          </button>
          <button
            className="cal-add"
            title="New goal"
            aria-label="Add goal"
            data-testid="goal-add"
            onClick={() => setAdding((a) => !a)}
          >
            ＋
          </button>
        </span>
      </div>
      {adding && (
        <div className="cal-add-form" data-testid="goal-add-form">
          <input
            autoFocus
            placeholder="New goal"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitAdd();
              if (e.key === "Escape") setAdding(false);
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
      {HORIZONS.map((h) => {
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
                              if (e.key === "Escape") setEditing(null);
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

// Memoized: App re-renders on every swipe step, but nothing the sidebar
// shows depends on the week view's pan offset.
export const Sidebar = memo(function Sidebar(props: {
  backend: Backend | null;
  calendars: Calendar[];
  anchor: Date;
  authed: boolean | null;
  accountEmail?: string;
  onPickDate: (d: Date) => void;
  onOpenReview: () => void;
  events?: CalendarEvent[];
}) {
  const { calendars } = props;
  const [adding, setAdding] = useState(false);
  const [calCollapsed, setCalCollapsed] = useState<{ my: boolean; other: boolean }>(() => {
    try {
      return JSON.parse(localStorage.getItem("cal-collapsed") ?? '{"my":false,"other":false}');
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

  const submitAdd = async () => {
    const v = addText.trim();
    if (!v || !props.backend) return;
    setAddErr(null);
    try {
      await props.backend.addCalendar(v, looksLikeId);
      setAddText("");
      setAdding(false);
    } catch (e) {
      setAddErr(String(e));
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
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <div className="cal-add-hint">
              {addText
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
            a.summary.localeCompare(b.summary, undefined, { sensitivity: "base" });
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
                          className={`cal-row${c.hidden ? " hidden-cal" : ""}`}
                          onClick={() => props.backend?.setCalendarHidden(c.id, !c.hidden)}
                          title={c.hidden ? "Show calendar" : "Hide calendar"}
                        >
                          <span
                            className="cal-dot"
                            style={{ background: normalizeCalendarColor(c.color) }}
                          />
                          <span className="cal-name">{c.summary}</span>
                          {c.is_primary && <span className="cal-default">Default</span>}
                          <span className="cal-eye">{c.hidden ? "Show" : "Hide"}</span>
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
      <GoalsSection backend={props.backend} onOpenReview={props.onOpenReview} events={props.events} />
      {!runningInTauri && <div className="mock-badge">browser mock mode</div>}
    </aside>
  );
});
