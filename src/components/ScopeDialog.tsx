// Google-style scope prompt for recurring events: applying an edit or delete
// to this event, this and following events, or the whole series.

import type { CalendarEvent, EventInput } from "../lib/types";

export interface PendingScope {
  kind: "edit" | "delete";
  event: CalendarEvent;
  input?: EventInput; // for edits
  label?: string;
  /** Whether the series can be split at the selected occurrence. */
  canSplit: boolean;
}

export type Scope = "this" | "following" | "all";

export function ScopeDialog(props: {
  pending: PendingScope;
  onPick: (scope: Scope) => void;
  onCancel: () => void;
}) {
  const { pending } = props;
  const verb = pending.kind === "delete" ? "Delete" : "Edit";
  return (
    <div className="scope-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="scope-dialog" data-testid="scope-dialog" role="dialog" aria-modal="true">
        <h3>
          {verb} recurring event
        </h3>
        <p className="scope-sub">“{pending.event.summary}” repeats.</p>
        <button className="scope-opt" data-testid="scope-this" onClick={() => props.onPick("this")}>
          This event
        </button>
        <button
          className="scope-opt"
          data-testid="scope-following"
          disabled={!pending.canSplit}
          title={pending.canSplit ? undefined : "Not available for this event"}
          onClick={() => props.onPick("following")}
        >
          This and following events
        </button>
        <button className="scope-opt" data-testid="scope-all" onClick={() => props.onPick("all")}>
          All events
        </button>
        <button className="scope-cancel" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
