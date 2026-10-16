// Where the person moved a margin note by hand (components/MarginNotes.tsx).
// Stored relative to the note's event — day columns across, minutes down —
// so a moved note stays put through zoom and window resizes. Per device
// (localStorage), like stars and reconciliation.

export interface NotePin {
  /** offset of the note's top-left from its event's title, in day columns */
  dxCol: number;
  /** the same, down, in minutes */
  dyMin: number;
  /** the text width the note was wrapped at */
  w: number;
  angle: number;
  /** the hand's size when it was moved (1 = 12px) */
  scale?: number;
}

type Listener = () => void;

const KEY = "note-pins";
let cache: Record<string, NotePin> | null = null;
const listeners = new Set<Listener>();

function load(): Record<string, NotePin> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    cache = {};
  }
  return cache!;
}

export function notePin(key: string): NotePin | null {
  return load()[key] ?? null;
}

export function setNotePin(key: string, pin: NotePin | null) {
  const m = load();
  if (pin) m[key] = pin;
  else delete m[key];
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode: the spot lasts for the session */
  }
  listeners.forEach((l) => l());
}

export function subscribeNotePins(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
