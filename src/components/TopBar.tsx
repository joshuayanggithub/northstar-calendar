import { useEffect, useRef, useState } from "react";
import { format } from "../lib/dates";
import type { View } from "./App";

const VIEW_ROWS: { v: View; label: string; key: string; days?: number }[] = [
  { v: "day", label: "Day", key: "D", days: 1 },
  { v: "week", label: "Week", key: "W" },
  { v: "month", label: "Month", key: "M" },
  { v: "list", label: "List", key: "L" },
  { v: "insights", label: "Insights", key: "I" },
];

export function TopBar(props: {
  anchor: Date;
  rangeEnd?: Date;
  view: View;
  dayCount: number;
  authed: boolean | null;
  connecting: boolean;
  onConnect: () => void;
  onViewChange: (v: View) => void;
  onDayCount: (n: number) => void;
  seamStyle?: "scarf" | "rabbet" | "overlay";
  onSeamStyle?: (s: "scarf" | "rabbet" | "overlay") => void;
  spotlight?: boolean;
  onSpotlight?: () => void;
  onToday: () => void;
  onStep: (dir: 1 | -1) => void;
  onOpenCommand: () => void;
}) {
  const { anchor, view } = props;
  const end = props.rangeEnd;
  let title: string;
  if (view === "insights") {
    title = "Insights";
  } else if (view === "day" && end && end.getMonth() === anchor.getMonth()) {
    // an N-day view names its days
    title = end.getDate() === anchor.getDate() ? format(anchor, "MMMM d, yyyy") : `${format(anchor, "MMM d")} – ${format(end, "d, yyyy")}`;
  } else if (end && end.getMonth() !== anchor.getMonth() && (view === "day" || view === "week" || view === "list")) {
    title =
      end.getFullYear() === anchor.getFullYear()
        ? `${format(anchor, "MMM")} – ${format(end, "MMM yyyy")}`
        : `${format(anchor, "MMM yyyy")} – ${format(end, "MMM yyyy")}`;
  } else {
    title = format(anchor, "MMMM yyyy");
  }
  return (
    <header className="topbar">
      <h1 className="topbar-title">{title}</h1>
      <div className="topbar-right">
        {props.authed === false && (
          <button className="btn btn-accent" onClick={props.onConnect} disabled={props.connecting}>
            {props.connecting ? "Waiting for Google…" : "Connect Google"}
          </button>
        )}
        <button
          className="btn btn-ghost"
          title="Command menu (⌘K)"
          onClick={props.onOpenCommand}
          aria-label="Command menu"
        >
          ⌘K
        </button>
        <ViewMenu
          view={view}
          dayCount={props.dayCount}
          onViewChange={props.onViewChange}
          onDayCount={props.onDayCount}
          seamStyle={props.seamStyle}
          onSeamStyle={props.onSeamStyle}
        />
        {props.onSpotlight && (
          <button
            className={"btn btn-ghost spotlight-btn" + (props.spotlight ? " active" : "")}
            title="Spotlight goal work (G)"
            aria-pressed={props.spotlight}
            data-testid="spotlight-btn"
            onClick={props.onSpotlight}
          >
            ★
          </button>
        )}
        <button className="btn" onClick={props.onToday}>
          Today
        </button>
        <div className="chevrons">
          <button className="btn btn-ghost" aria-label="Previous" onClick={() => props.onStep(-1)}>
            ‹
          </button>
          <button className="btn btn-ghost" aria-label="Next" onClick={() => props.onStep(1)}>
            ›
          </button>
        </div>
      </div>
    </header>
  );
}

/** Notion: one dropdown carries every view plus the custom day counts. */
function ViewMenu(props: {
  view: View;
  dayCount: number;
  onViewChange: (v: View) => void;
  onDayCount: (n: number) => void;
  seamStyle?: "scarf" | "rabbet" | "overlay";
  onSeamStyle?: (s: "scarf" | "rabbet" | "overlay") => void;
  spotlight?: boolean;
  onSpotlight?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // every way of closing folds the submenus (View settings stayed open)
    if (!open) {
      setDaysOpen(false);
      setSettingsOpen(false);
      return;
    }
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    // capture: the grid stops its pointerdown from bubbling to the window
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const isDays = props.view === "day" && props.dayCount > 1;
  const current = isDays
    ? `${props.dayCount} days`
    : (VIEW_ROWS.find((r) => r.v === props.view)?.label ?? "Week");
  return (
    <div className="view-menu" ref={ref}>
      <button
        className="btn view-menu-btn"
        data-testid="view-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current} <span className="view-menu-caret">▾</span>
      </button>
      {open && (
        <div className="view-menu-pop" role="menu" data-testid="view-menu">
          {VIEW_ROWS.map((r) => (
            <button
              key={r.v}
              role="menuitem"
              className="view-menu-row"
              onClick={() => {
                if (r.days) props.onDayCount(r.days);
                props.onViewChange(r.v);
                setOpen(false);
              }}
            >
              <span className="view-menu-check">
                {props.view === r.v && (r.v !== "day" || props.dayCount === 1) ? "✓" : ""}
              </span>
              {r.label}
              <kbd>{r.key}</kbd>
            </button>
          ))}
          <button
            role="menuitem"
            className="view-menu-row"
            onClick={() => setDaysOpen((d) => !d)}
            data-testid="view-menu-days"
          >
            <span className="view-menu-check">{isDays ? "✓" : ""}</span>
            Number of days
            <span className="view-menu-sub">›</span>
          </button>
          {daysOpen &&
            [2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button
                key={n}
                role="menuitem"
                className="view-menu-row view-menu-day"
                onClick={() => {
                  props.onDayCount(n);
                  props.onViewChange("day");
                  setOpen(false);
                }}
              >
                <span className="view-menu-check">{isDays && props.dayCount === n ? "✓" : ""}</span>
                {n} days
                <kbd>{n}</kbd>
              </button>
            ))}
          {props.onSeamStyle && (
            <button
              role="menuitem"
              className="view-menu-row"
              data-testid="view-menu-settings"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <span className="view-menu-check" />
              View settings
              <span className="view-menu-sub">›</span>
            </button>
          )}
          {settingsOpen &&
            props.onSeamStyle &&
            (["scarf", "rabbet", "overlay"] as const).map((s) => (
              <button
                key={s}
                role="menuitem"
                className="view-menu-row view-menu-day"
                onClick={() => props.onSeamStyle!(s)}
              >
                <span className="view-menu-check">{props.seamStyle === s ? "✓" : ""}</span>
                {s === "scarf" ? "Scarf joint" : s === "rabbet" ? "Rabbet joint" : "Overlay"}
                <span className="view-menu-sub">overlaps</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
