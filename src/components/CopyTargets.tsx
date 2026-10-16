// "Copy to my calendar": the calendars an event on one of the "Other
// calendars" can be copied into (yours, the default first), and for a
// recurring one whether to take every occurrence. Picking a calendar is the
// copy, so copying and filing it under the right calendar are one step.
// Used by the event panel and the week's right-click menu.

import { useState } from "react";
import { colorOf } from "../lib/useBackend";
import { calendarEditable, type Calendar } from "../lib/types";

export function CopyTargets(props: {
  calendars: Calendar[];
  recurring: boolean;
  onPick: (calendarId: string, series: boolean) => void;
}) {
  const [series, setSeries] = useState(false);
  const mine = props.calendars
    .filter((c) => calendarEditable(c) && !c.hidden)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  return (
    <div className="copy-targets" data-testid="copy-targets" role="menu" aria-label="Copy to calendar">
      <div className="copy-targets-head">Copy to</div>
      {props.recurring && (
        <label className="copy-series">
          <input
            type="checkbox"
            data-testid="copy-series"
            checked={series}
            onChange={(e) => setSeries(e.target.checked)}
          />
          Every occurrence
        </label>
      )}
      {mine.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          className="copy-target"
          data-testid="copy-target"
          data-cal={c.id}
          onClick={() => props.onPick(c.id, series)}
        >
          <span className="cal-dot" style={{ background: colorOf(props.calendars, c.id) }} />
          <span>{c.summary}</span>
        </button>
      ))}
    </div>
  );
}
