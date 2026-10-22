// ⌘K command menu (cmdk): navigation, view switching, calendar toggles,
// date jump via natural language, event search.

import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import * as chrono from "chrono-node";
import { LOCALE, addDays, now, toLocalISO } from "../lib/dates";
import { colorOf } from "../lib/useBackend";
import { readOnlyEvent, type Backend, type Calendar, type CalendarEvent } from "../lib/types";
import { copiedKeys } from "../lib/copies";
import type { View } from "./App";

export function CommandMenu(props: {
  backend: Backend | null;
  calendars: Calendar[];
  onClose: () => void;
  onGoto: (d: Date) => void;
  onView: (v: View) => void;
  onToday: () => void;
  /** the menu bar's Sync now (it reports the pass's outcome) */
  onSync: () => void;
  onNewEvent: () => void;
  onOpenEvent: (e: CalendarEvent) => void;
  secondaryTz: string | null;
  onSecondaryTz: (tz: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CalendarEvent[]>([]);

  const dateHit = useMemo(() => {
    const q = query.trim().replace(/^(?:go\s*to|jump\s+to)\s+/i, "");
    if (q.length < 3) return null;
    // "last friday", "3 days ago" look back (forwardDate sent them to next week)
    const back = /\b(?:last|past|previous|ago|yesterday)\b/i.test(q);
    const [r] = chrono.parse(q, now(), { forwardDate: !back });
    // the whole query a date: "sync now" isn't a jump to now
    if (!r || r.index !== 0 || r.text.length < q.length) return null;
    let d = r.start.date();
    // earlier this month is this month ("oct 12" on Oct 19 isn't 2027);
    // further back stays ahead ("jan 3" in October is next January)
    if (!back && d.getFullYear() > now().getFullYear()) {
      const plain = chrono.parseDate(q, now());
      if (plain && plain.getFullYear() === now().getFullYear() && plain.getMonth() === now().getMonth()) d = plain;
    }
    return d;
  }, [query]);

  // Event search over ±90 days, filtered client-side.
  useEffect(() => {
    if (!props.backend || query.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const s = toLocalISO(addDays(now(), -90));
      const e = toLocalISO(addDays(now(), 90));
      const all = await props.backend!.listEvents(s, e);
      const q = query.toLowerCase();
      const hidden = new Set(props.calendars.filter((c) => c.hidden).map((c) => c.id));
      // From now: upcoming first (soonest), then the most recent past; one
      // per series, its occurrence nearest now. (In stored order the oldest
      // occurrence of a weekly series won, and the 8 oldest matches crowded
      // out tomorrow's.)
      const t0 = now().getTime();
      const rank = (ev: CalendarEvent) => {
        const at = new Date(ev.all_day ? ev.start + "T00:00" : ev.start).getTime();
        const endAt = new Date(ev.all_day ? ev.end + "T00:00" : ev.end).getTime();
        return endAt >= t0 ? at - t0 : 1e15 + (t0 - at);
      };
      // (a copied original is shown once, as your copy; a copy on a hidden
      // calendar isn't shown, so its original is: a hidden copy found neither)
      const copied = copiedKeys(all.filter((e) => !hidden.has(e.calendar_id)), (e) => readOnlyEvent(e, props.calendars));
      const best = new Map<string, CalendarEvent>();
      for (const ev of all) {
        if (hidden.has(ev.calendar_id)) continue;
        if (copied.has(`${ev.calendar_id}/${ev.id}`)) continue;
        if (!(ev.summary.toLowerCase().includes(q) || (ev.description ?? "").toLowerCase().includes(q))) continue;
        const key = ev.recurring_event_id ?? ev.id;
        const was = best.get(key);
        if (!was || rank(ev) < rank(was)) best.set(key, ev);
      }
      setHits([...best.values()].sort((a, b) => rank(a) - rank(b)).slice(0, 8));
    }, 120);
    return () => clearTimeout(t);
  }, [query, props.backend, props.calendars]);

  return (
    <div className="cmdk-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <Command className="cmdk" label="Command menu" shouldFilter={query.trim().length > 0}>
        <Command.Input
          autoFocus
          placeholder="Search events, jump to a date, run a command…"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => {
            // the menu's Escape is the menu's: not also the editor under it
            if (e.key === "Escape") {
              e.stopPropagation();
              props.onClose();
            }
          }}
        />
        <Command.List>
          <Command.Empty>No results.</Command.Empty>

          {dateHit && (
            <Command.Group heading="Go to">
              <Command.Item
                value={`goto ${query}`}
                onSelect={() => {
                  props.onGoto(dateHit);
                  props.onClose();
                }}
              >
                📅 Go to{" "}
                {dateHit.toLocaleDateString(LOCALE, {
                  weekday: "short",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </Command.Item>
            </Command.Group>
          )}

          {hits.length > 0 && (
            <Command.Group heading="Events">
              {hits.map((e) => (
                <Command.Item
                  key={`${e.calendar_id}/${e.id}`}
                  value={`event ${e.summary} ${e.id}`}
                  // (a hit on the description must survive cmdk's own filter)
                  keywords={[e.description ?? ""]}
                  onSelect={() => {
                    props.onOpenEvent(e);
                    props.onClose();
                  }}
                >
                  🔍 {e.summary}
                  <span className="cmdk-sub">
                    {new Date(e.all_day ? e.start + "T00:00" : e.start).toLocaleDateString(LOCALE, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Commands">
            <Command.Item value="new event create" onSelect={() => { props.onNewEvent(); props.onClose(); }}>
              ＋ New event
            </Command.Item>
            <Command.Item value="go to today" onSelect={() => { props.onToday(); props.onClose(); }}>
              ◎ Today
            </Command.Item>
            {(["day", "week", "month", "list"] as View[]).map((v) => (
              <Command.Item key={v} value={`${v} view`} onSelect={() => { props.onView(v); props.onClose(); }}>
                ▦ {v[0].toUpperCase() + v.slice(1)} view
              </Command.Item>
            ))}
            <Command.Item value="insights stats productivity sleep distraction" onSelect={() => { props.onView("insights" as View); props.onClose(); }}>
              📈 Insights
            </Command.Item>
            <Command.Item value="sync now refresh" onSelect={() => { props.onSync(); props.onClose(); }}>
              ↻ Sync now
            </Command.Item>
          </Command.Group>

          {/* after the commands, and only when asked for: its labels fuzzy-
              matched "new" and "day" ahead of New event / Day view */}
          {(query.trim() === "" || /zone|tz|time|secondary|utc|gmt|pacific|eastern|london|tokyo|none|new york|york|los angeles|angeles/i.test(query)) && (
          <Command.Group heading="Secondary time zone">
            {[
              ["None", null],
              ["UTC", "UTC"],
              ["Pacific (Los Angeles)", "America/Los_Angeles"],
              ["Eastern (New York)", "America/New_York"],
              ["London", "Europe/London"],
              ["Tokyo", "Asia/Tokyo"],
            ].map(([label, tz]) => (
              <Command.Item
                key={String(tz)}
                value={`time zone secondary ${label}`}
                onSelect={() => {
                  props.onSecondaryTz(tz as string | null);
                  props.onClose();
                }}
              >
                🌐 {label}
                {props.secondaryTz === tz && <span className="cmdk-sub">current</span>}
              </Command.Item>
            ))}
          </Command.Group>
          )}

          {props.calendars.length > 0 && query.trim().length > 0 && (
            <Command.Group heading="Calendars">
              {props.calendars.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`calendar toggle ${c.summary}`}
                  onSelect={() => props.backend?.setCalendarHidden(c.id, !c.hidden)}
                >
                  <span className="cal-dot" style={{ background: colorOf(props.calendars, c.id) }} />
                  {c.hidden ? "Show" : "Hide"} {c.summary}
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}
