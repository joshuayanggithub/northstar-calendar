// Undo stack (⌘Z) with toast notifications, Notion/Google style: every
// mutation registers its inverse; undoing runs it and shows a toast.

export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
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

export function recordUndo(label: string, undo: () => Promise<void>) {
  stack.push({ label, undo });
  if (stack.length > 50) stack.shift();
  showToast(label, true);
}

export function showToast(label: string, canUndo: boolean) {
  emit({ label, canUndo });
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => emit(null), 5000);
}

export async function undoLast(): Promise<boolean> {
  const entry = stack.pop();
  if (!entry) return false;
  try {
    await entry.undo();
    showToast(`Undid: ${entry.label}`, false);
  } catch (e) {
    showToast(`Undo failed: ${e}`, false);
  }
  return true;
}

export function dismissToast() {
  if (hideTimer) clearTimeout(hideTimer);
  emit(null);
}
