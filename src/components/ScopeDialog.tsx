// Google-style scope prompt for recurring events: applying an edit or delete
// to this event, this and following events, or the whole series.

import { useRef } from "react";
import type { CalendarEvent, EventInput } from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";
import { RSVP_WORD, type Rsvp } from "../lib/rsvp";

export interface PendingScope {
  /** rsvp: your answer to a recurring invitation (this one, or every one) */
  kind: "edit" | "delete" | "rsvp";
  rsvp?: Rsvp;
  event: CalendarEvent;
  input?: EventInput; // for edits
  label?: string;
  /** Whether the series can be split at the selected occurrence. */
  canSplit: boolean;
  /** the edit moves it to another calendar: Google moves only whole series,
   *  so "This event" would be refused (and revert) */
  noThis?: boolean;
}

export type Scope = "this" | "following" | "all";

export function ScopeDialog(props: {
  pending: PendingScope;
  onPick: (scope: Scope) => void;
  onCancel: () => void;
}) {
  const { pending } = props;
  const verb = pending.kind === "delete" ? "Delete" : "Edit";
  const rsvp = pending.kind === "rsvp";
  // the keyboard is the dialog's: its first choice focused (Enter picks it)
  const box = useRef<HTMLDivElement | null>(null);
  useModalFocus(box, ".scope-opt:not([disabled])");
  return (
    <div className="scope-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div ref={box} tabIndex={-1} className="scope-dialog" data-testid="scope-dialog" role="dialog" aria-modal="true">
        <h3>{rsvp ? "Reply to recurring event" : `${verb} recurring event`}</h3>
        <p className="scope-sub">
          {rsvp
            ? `“${RSVP_WORD[pending.rsvp ?? "accepted"]}” to “${pending.event.summary}”: just this one, or every occurrence?`
            : `“${pending.event.summary}” repeats.`}
        </p>
        <button
          className="scope-opt"
          data-testid="scope-this"
          disabled={!!pending.noThis}
          title={pending.noThis ? "One occurrence can't move to another calendar" : undefined}
          onClick={() => props.onPick("this")}
        >
          This event
        </button>
        {/* (a guest can't split the organizer's series) */}
        {!rsvp && (
          <button
            className="scope-opt"
            data-testid="scope-following"
            disabled={!pending.canSplit}
            title={pending.canSplit ? undefined : "Not available for this event"}
            onClick={() => props.onPick("following")}
          >
            This and following events
          </button>
        )}
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
