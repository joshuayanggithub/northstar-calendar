// Drag handles for the side panes: the sidebar's right edge and the event
// panel's left edge. The width is remembered per device (localStorage, like
// the other view settings); double-click puts the default back, and with the
// handle focused the arrow keys nudge it.

import { useCallback, useEffect, useRef, useState } from "react";

export interface PaneSpec {
  /** localStorage key */
  key: string;
  def: number;
  min: number;
  max: number;
}

export const SIDEBAR_PANE: PaneSpec = { key: "pane-w-sidebar", def: 232, min: 190, max: 480 };
export const PANEL_PANE: PaneSpec = { key: "pane-w-panel", def: 316, min: 280, max: 760 };

/** never let a pane take more than this share of the window */
const MAX_SHARE = 0.6;

function clampTo(p: PaneSpec, w: number): number {
  const cap = Math.max(p.min, Math.min(p.max, Math.round(window.innerWidth * MAX_SHARE)));
  return Math.round(Math.min(cap, Math.max(p.min, w)));
}

export function usePaneWidth(p: PaneSpec): [number, (w: number) => void] {
  const [w, setW] = useState(() => {
    try {
      // the chosen width, not today's window cap: clamped here, a launch at
      // 800px wide lost anything over 480 for good (the return clamps)
      const v = Number(localStorage.getItem(p.key));
      return v ? Math.max(p.min, Math.min(p.max, v)) : p.def;
    } catch {
      return p.def;
    }
  });
  // the window narrowed since: show the width within the cap (the chosen
  // width comes back when it widens again)
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const set = useCallback(
    (next: number) => {
      const v = clampTo(p, next);
      setW(v);
      try {
        if (v === p.def) localStorage.removeItem(p.key);
        else localStorage.setItem(p.key, String(v));
      } catch {
        /* private mode: the width lasts for the session */
      }
    },
    [p],
  );
  return [clampTo(p, w), set];
}

export function PaneResize(props: {
  pane: PaneSpec;
  width: number;
  onWidth: (w: number) => void;
  /** which side of the handle the pane is on: dragging away from it widens it */
  paneSide: "left" | "right";
  className?: string;
  label: string;
}) {
  const [active, setActive] = useState(false);
  const raf = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    [],
  );
  const dir = props.paneSide === "left" ? 1 : -1;
  return (
    <div
      className={"pane-resize" + (active ? " active" : "") + (props.className ? ` ${props.className}` : "")}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={props.width}
      aria-valuemin={props.pane.min}
      aria-valuemax={props.pane.max}
      tabIndex={0}
      title={`Drag to resize · double-click to reset`}
      data-testid={`resize-${props.pane.key}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const w0 = props.width;
        setActive(true);
        document.documentElement.classList.add("pane-resizing");
        let latest = w0;
        const move = (ev: PointerEvent) => {
          latest = w0 + dir * (ev.clientX - x0);
          // one width per frame: the week re-lays out on every change
          if (raf.current == null) {
            raf.current = requestAnimationFrame(() => {
              raf.current = null;
              props.onWidth(latest);
            });
          }
        };
        const end = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", end);
          el.removeEventListener("pointercancel", end);
          if (raf.current != null) {
            cancelAnimationFrame(raf.current);
            raf.current = null;
          }
          props.onWidth(latest);
          setActive(false);
          document.documentElement.classList.remove("pane-resizing");
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end);
      }}
      onDoubleClick={() => props.onWidth(props.pane.def)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 48 : 16;
        props.onWidth(props.width + (e.key === "ArrowRight" ? step : -step) * dir);
      }}
    />
  );
}
