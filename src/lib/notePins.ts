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
  /** the hand's size (1 = 12px) */
  scale?: number;
  /** set once the person sized the box: its height in px (0 = as tall as
   *  its text), and `w` is then the box's text width exactly */
  h?: number;
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
  // pins were kept by calendar/id: a calendar move (same id) lost them
  for (const k of Object.keys(cache!)) {
    if (!k.includes("/")) continue;
    if (!cache![idOf(k)]) cache![idOf(k)] = cache![k];
    delete cache![k];
  }
  return cache!;
}

/** callers pass the event's calendar/id key; a pin belongs to the event id
 *  (Google keeps it across a calendar move) */
const idOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);

export function notePin(key: string): NotePin | null {
  return load()[idOf(key)] ?? null;
}

export function setNotePin(key: string, pin: NotePin | null) {
  const m = load();
  if (pin) m[idOf(key)] = pin;
  else delete m[idOf(key)];
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
