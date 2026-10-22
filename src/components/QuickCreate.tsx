// Floating natural-language quick create ("c"): parses as you type and shows
// a live preview of what will be created.

import { useMemo, useState, useRef } from "react";
import { parseQuickCreate } from "../lib/nlp";
import { LOCALE, toDateOnly, toLocalISO } from "../lib/dates";
import { calendarEditable, type Backend, type Calendar } from "../lib/types";
import type { EventActions } from "./App";

export function QuickCreate(props: {
  /** the calendar isolated in the sidebar, if any */
  isolated?: string | null;
  backend: Backend | null;
  calendars: Calendar[];
  actions: EventActions;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(() => parseQuickCreate(text), [text]);

  const preview = useMemo(() => {
    if (!parsed) return "";
    const day = parsed.start.toLocaleDateString(LOCALE, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const rep = parsed.recurrenceLabel ? ` · repeats ${parsed.recurrenceLabel}` : "";
    if (parsed.allDay) return `${parsed.title} · ${day} · all day${rep}`;
    const t = (d: Date) => d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
    return `${parsed.title} · ${day} · ${t(parsed.start)} – ${t(parsed.end)}${rep}`;
  }, [parsed]);

  // (one request at a time: Enter twice made two events)
  const busy = useRef(false);
  const create = async () => {
    if (!props.backend || !parsed || busy.current) return;
    // the isolated calendar when it's yours (as the editor defaults to),
    // else your default one (quick create put an event on Personal while
    // Work was isolated, where it couldn't be seen)
    const editable = props.calendars.filter(calendarEditable);
    // (and one that's shown: with Personal unchecked the event went there,
    // unseen)
    const shown = editable.filter((c) => !c.hidden);
    const cal = editable.find((c) => c.id === props.isolated) ??
      shown.find((c) => c.is_primary) ?? shown[0] ?? editable.find((c) => c.is_primary) ?? editable[0];
    if (!cal) {
      setError("No calendar available — connect Google first.");
      return;
    }
    busy.current = true;
    try {
      await props.actions.create({
        calendar_id: cal.id,
        summary: parsed.title,
        start: parsed.allDay ? toDateOnly(parsed.start) : toLocalISO(parsed.start),
        end: parsed.allDay ? toDateOnly(parsed.end) : toLocalISO(parsed.end),
        all_day: parsed.allDay,
        recurrence: parsed.recurrence ?? null,
      });
      props.onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="qc-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="quick-create" data-testid="quick-create">
        <input
          autoFocus
          placeholder="New event — try “lunch with Sam tue 12:30”"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // (an IME's Enter commits its conversion, not the event)
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") create();
            if (e.key === "Escape") props.onClose();
          }}
        />
        {text && <div className="qc-preview">{preview}</div>}
        {error && <div className="qc-error">{error}</div>}
      </div>
    </div>
  );
}
