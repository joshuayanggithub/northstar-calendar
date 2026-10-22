// A modal dialog holds the keyboard: focus moves in when it opens (to its
// first matching control, or the dialog itself), Tab and Shift-Tab wrap
// inside it, and focus goes back where it was when it closes. Help and
// Settings are aria-modal but left focus on the page: Tab reached the chips
// behind them, and ⌘, mid-title kept typing into the title.

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(ref: RefObject<HTMLElement | null>, initial?: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement as HTMLElement | null;
    const first = initial ? el.querySelector<HTMLElement>(initial) : null;
    (first ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      // every Tab is the dialog's: WebKit with Full Keyboard Access off
      // stops only on text fields, so Tab from a button left the dialog for
      // a field behind it (Help had none of its own)
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const n = items.length;
      const next = i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + n) % n;
      items[next].focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (before && before !== document.body && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [ref, initial]);
}
