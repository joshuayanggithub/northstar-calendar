// Floating natural-language quick create ("c"): parses as you type and shows
// a live preview of what will be created.

import { useMemo, useState } from "react";
import { parseQuickCreate } from "../lib/nlp";
import { toDateOnly, toLocalISO } from "../lib/dates";
import type { Backend, Calendar } from "../lib/types";
import type { EventActions } from "./App";

export function QuickCreate(props: {
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
    const day = parsed.start.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const rep = parsed.recurrenceLabel ? ` · repeats ${parsed.recurrenceLabel}` : "";
    if (parsed.allDay) return `${parsed.title} · ${day} · all day${rep}`;
    const t = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${parsed.title} · ${day} · ${t(parsed.start)} – ${t(parsed.end)}${rep}`;
  }, [parsed]);

  const create = async () => {
    if (!props.backend || !parsed) return;
    const cal = props.calendars.find((c) => c.is_primary) ?? props.calendars[0];
    if (!cal) {
      setError("No calendar available — connect Google first.");
      return;
    }
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
