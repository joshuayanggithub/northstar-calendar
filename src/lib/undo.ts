// Undo stack (⌘Z) with toast notifications, Notion/Google style: every
// mutation registers its inverse; undoing runs it and shows a toast.

export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  /** a change ⌘Z can't take back (a whole-series edit or delete): it stops
   *  there instead of undoing whatever older edit lies below it */
  barrier?: boolean;
}

type Listener = (toast: { label: string; canUndo: boolean } | null) => void;

const stack: UndoEntry[] = [];
const listeners = new Set<Listener>();
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function emit(toast: { label: string; canUndo: boolean } | null) {
  listeners.forEach((l) => l(toast));
}

export function onToast(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Undoing a delete re-creates the event under a new id: older undo steps
 *  still name the old one. They resolve it through here. */
const alias = new Map<string, string>();
export function aliasId(oldId: string, newId: string) {
  alias.set(oldId, newId);
}
export function liveId(id: string): string {
  for (let i = 0; i < 32 && alias.has(id); i++) id = alias.get(id)!;
  return id;
}

export function recordUndo(label: string, undo: () => Promise<void>) {
  stack.push({ label, undo });
  if (stack.length > 50) stack.shift();
  showToast(label, true);
}

/** A change that can't be undone: shown like any other, and ⌘Z stops at it
 *  (and says so) instead of reaching an older, unrelated edit. */
export function recordBarrier(label: string) {
  stack.push({ label, undo: async () => {}, barrier: true });
  if (stack.length > 50) stack.shift();
  showToast(label, false);
}

export function showToast(label: string, canUndo: boolean) {
  emit({ label, canUndo });
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => emit(null), 5000);
}

let undoing = false;
export async function undoLast(): Promise<boolean> {
  // (one at a time: a double-click on the toast's Undo, or ⌘Z mashed,
  // reached the older entry under the one being undone)
  if (undoing) return true;
  const entry = stack[stack.length - 1];
  if (!entry) return false;
  // a barrier stays: a second ⌘Z (people mash it when nothing seems to
  // happen) must not reach the older, unrelated edit under it
  if (entry.barrier) {
    showToast(`Can't undo: ${entry.label}`, false);
    return true;
  }
  stack.pop();
  undoing = true;
  try {
    await entry.undo();
    showToast(`Undid: ${entry.label}`, false);
  } catch (e) {
    showToast(`Undo failed: ${e}`, false);
  } finally {
    undoing = false;
  }
  return true;
}

export function dismissToast() {
  if (hideTimer) clearTimeout(hideTimer);
  emit(null);
}
