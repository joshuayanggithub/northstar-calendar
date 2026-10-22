// Help (Help menu, or ⌘/ for the shortcuts): a short guide to what the app
// does and every keyboard shortcut, in the settings window's frame.

import { useEffect, useRef } from "react";
import { useModalFocus } from "../lib/useModalFocus";

export type HelpTab = "guide" | "shortcuts";

const K = (props: { k: string }) => <kbd className="help-kbd">{props.k}</kbd>;

// The sheet shows each key's mnemonic: the letter in [brackets] is the key
// (W for [W]eek). Keys are first letters where they can be, arrows for
// moving, ⌘ for the app's own commands, ⇧ for the opposite direction.
const SHORTCUTS: [string, [string[], string][]][] = [
  ["Views", [
    [["W"], "[W]eek"],
    [["D"], "[D]ay"],
    [["2", "–", "9"], "2 to 9 days"],
    [["M"], "[M]onth"],
    [["L"], "[L]ist"],
    [["I"], "[I]nsights"],
    [["⇧⌘E"], "Show or hide week[e]nds"],
    [["⇧⌘D"], "Show or hide [d]eclined invitations"],
    [["A"], "Show or hide your notes ([a]nnotations)"],
    [["`"], "Show or hide the sidebar"],
    [["⌘+", "⌘−"], "Zoom the hours in / out (also ⇧⌘. and ⇧⌘,)"],
    [["⌘0"], "Actual size"],
  ]],
  ["Getting around", [
    [["T"], "[T]oday"],
    [["→", "←"], "Next / previous week, day or month (also J / K)"],
    [["⌘K"], "Command menu: jump to a date, find an event, run a command (also /)"],
    [["G"], "Spotlight your [g]oal work"],
    [["⌘J"], "[J]oin the next meeting"],
  ]],
  ["Events", [
    [["C"], "[C]reate quickly: type “lunch tomorrow 12-1”"],
    [["⌘N"], "[N]ew event in the editor"],
    [["N", "P"], "Select the [n]ext / [p]revious event"],
    [["X"], "Select the event under the pointer (X marks it)"],
    [["↩", "E"], "Open ([e]dit) the selected event"],
    [["⌘C", "⌘X", "⌘V"], "Copy, cut, paste onto the day you're on"],
    [["⌘D"], "[D]uplicate"],
    [["⌥", "drag"], "Duplicate by dragging"],
    [["⌫"], "Delete"],
    [["⌘A"], "Select [a]ll events on screen"],
    [["⌘Z"], "Undo"],
    [["Esc"], "Close, deselect, or leave an isolated calendar"],
  ]],
  ["Review: did it happen?", [
    [["R"], "[R]eview the last two days"],
    [["Y", "N"], "[Y]es it happened / [N]o it didn't"],
    [["C"], "[C]anceled: kept, struck through"],
    [["S"], "[S]kip"],
    [["M"], "Open it ([m]ore)"],
  ]],
  ["App", [
    [["⌘,"], "Settings"],
    [["?"], "This list (also ⌘/)"],
    [["⌥C"], "From any app: quick create"],
  ]],
];

/** the mnemonic letters in [brackets] drawn as the key they stand for */
function Mnemonic(props: { text: string }) {
  const parts = props.text.split(/(\[[^\]]\])/);
  return (
    <>
      {parts.map((p, i) => (p.length === 3 && p.startsWith("[") ? <b key={i} className="help-mn">{p[1]}</b> : p))}
    </>
  );
}

const GUIDE: [string, string][] = [
  ["Create", "Drag on the grid, double-click a day, or press C and type it: “dentist friday 4:30”, “gym mon wed fri 7am”, “deep work 9-11”. Times, days and repeats are understood."],
  ["Edit and move", "Drag to move, drag the bottom edge to resize, ⌥-drag to copy. Click an event to open it; changes save as you go. A recurring event asks whether a change is for this one, this and following, or all."],
  ["Google Calendar", "Everything syncs with Google both ways within seconds: edits made here or in Google show up on the other side. Settings › Calendar accounts connects your account and chooses which calendars show."],
  ["Invitations", "Invitations you haven't answered are outlined; maybe is striped, declined is struck through. Open one to see who's coming and answer Yes, No or Maybe (for one occurrence or all of them)."],
  ["Review your day", "Press R to go through the last two days: did each event happen? Confirmed deep work counts toward your day score; the rest fades."],
  ["Notes", "Write a red-pen margin note on any event; it stays with that occurrence only."],
  ["Cancel without deleting", "Right-click an event (or its ⋯ menu) and choose Cancel event: it stays on your calendar, lightened and struck through, out of Insights and with no alert. Restore it the same way, or ⌘Z. Moved to a new time, it's on again."],
  ["Isolate a calendar", "Right-click a calendar in the sidebar and choose Isolate to see only its events. Show all (or Esc) brings the rest back."],
  ["Insights", "Where your time went, how you slept, when you focus and when you drift, compared with the stretch before. Settings › Insights chooses which calendars count as deep work."],
];

export function HelpDialog(props: { tab: HelpTab; onTab: (t: HelpTab) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const win = useRef<HTMLDivElement | null>(null);
  useModalFocus(win);

  return (
    <div className="set-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={win} tabIndex={-1} className="set-window help-window" role="dialog" aria-modal="true" aria-label="Help" data-testid="help">
        <header className="help-head">
          <h2>{props.tab === "guide" ? "North Star Help" : "Keyboard Shortcuts"}</h2>
          <nav className="help-tabs" role="tablist">
            <button role="tab" aria-selected={props.tab === "guide"} className={props.tab === "guide" ? "on" : ""} onClick={() => props.onTab("guide")}>Guide</button>
            <button role="tab" aria-selected={props.tab === "shortcuts"} className={props.tab === "shortcuts" ? "on" : ""} onClick={() => props.onTab("shortcuts")}>Shortcuts</button>
          </nav>
          <button className="set-close" aria-label="Close help" onClick={props.onClose}>✕</button>
        </header>
        <div className="help-body">
          {props.tab === "guide" ? (
            <div className="help-guide">
              {GUIDE.map(([title, text]) => (
                <section key={title} className="set-group">
                  <h3>{title}</h3>
                  <p>{text}</p>
                </section>
              ))}
            </div>
          ) : (
            <div className="help-shortcuts">
              {SHORTCUTS.map(([group, rows]) => (
                <section key={group} className="set-group">
                  <h3>{group}</h3>
                  <dl>
                    {rows.map(([keys, what]) => (
                      <div key={what} className="help-row">
                        <dt>{keys.map((k, i) => (k === "–" ? <span key={i} className="help-dash">–</span> : <K key={i} k={k} />))}</dt>
                        <dd><Mnemonic text={what} /></dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
