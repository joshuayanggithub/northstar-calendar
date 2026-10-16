// ⌘K command menu (cmdk): navigation, view switching, calendar toggles,
// date jump via natural language, event search.

import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import * as chrono from "chrono-node";
import { addDays, now, toLocalISO } from "../lib/dates";
import { normalizeCalendarColor } from "../lib/color";
import type { Backend, Calendar, CalendarEvent } from "../lib/types";
import type { View } from "./App";

export function CommandMenu(props: {
  backend: Backend | null;
  calendars: Calendar[];
  onClose: () => void;
  onGoto: (d: Date) => void;
  onView: (v: View) => void;
  onToday: () => void;
  onNewEvent: () => void;
  onOpenEvent: (e: CalendarEvent) => void;
  secondaryTz: string | null;
  onSecondaryTz: (tz: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CalendarEvent[]>([]);

  const dateHit = useMemo(() => {
    if (query.length < 3) return null;
    const r = chrono.parseDate(query, now(), { forwardDate: true });
    return r ?? null;
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
      const seen = new Set<string>();
      const out: CalendarEvent[] = [];
      for (const ev of all) {
        const key = ev.recurring_event_id ?? ev.id;
        if (seen.has(key)) continue;
        if (
          ev.summary.toLowerCase().includes(q) ||
          (ev.description ?? "").toLowerCase().includes(q)
        ) {
          seen.add(key);
          out.push(ev);
          if (out.length >= 8) break;
        }
      }
      setHits(out);
    }, 120);
    return () => clearTimeout(t);
  }, [query, props.backend]);

  return (
    <div className="cmdk-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <Command className="cmdk" label="Command menu" shouldFilter={query.trim().length > 0}>
        <Command.Input
          autoFocus
          placeholder="Search events, jump to a date, run a command…"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => e.key === "Escape" && props.onClose()}
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
                {dateHit.toLocaleDateString([], {
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
                  onSelect={() => {
                    props.onOpenEvent(e);
                    props.onClose();
                  }}
                >
                  🔍 {e.summary}
                  <span className="cmdk-sub">
                    {new Date(e.all_day ? e.start + "T00:00" : e.start).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

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

          <Command.Group heading="Commands">
            <Command.Item value="new event create" onSelect={() => { props.onNewEvent(); props.onClose(); }}>
              ＋ New event
            </Command.Item>
            <Command.Item value="go to today" onSelect={() => { props.onToday(); props.onClose(); }}>
              ◎ Today
            </Command.Item>
            {(["day", "week", "month", "list"] as View[]).map((v) => (
              <Command.Item key={v} value={`view ${v}`} onSelect={() => { props.onView(v); props.onClose(); }}>
                ▦ {v[0].toUpperCase() + v.slice(1)} view
              </Command.Item>
            ))}
            <Command.Item value="weekly review journal goals obsidian" onSelect={() => { props.onView("review" as View); props.onClose(); }}>
              📓 Weekly review
            </Command.Item>
            <Command.Item value="insights stats productivity sleep distraction" onSelect={() => { props.onView("insights" as View); props.onClose(); }}>
              📈 Insights
            </Command.Item>
            <Command.Item value="sync now refresh" onSelect={() => { props.backend?.syncNow(); props.onClose(); }}>
              ↻ Sync now
            </Command.Item>
          </Command.Group>

          {props.calendars.length > 0 && query.trim().length > 0 && (
            <Command.Group heading="Calendars">
              {props.calendars.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`calendar toggle ${c.summary}`}
                  onSelect={() => props.backend?.setCalendarHidden(c.id, !c.hidden)}
                >
                  <span className="cal-dot" style={{ background: normalizeCalendarColor(c.color) }} />
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
