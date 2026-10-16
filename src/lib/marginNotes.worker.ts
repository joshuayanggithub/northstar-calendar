// Places margin notes off the main thread (components/MarginNotes.tsx).
// The page's word widths come along, measured where the font lives.
import { placeNotes, type Field, type NoteSpec } from "./marginNotes";

self.onmessage = (ev: MessageEvent<{ seq: number; field: Field; specs: NoteSpec[]; widths: Record<string, number> }>) => {
  const { seq, field, specs, widths } = ev.data;
  const places = placeNotes(field, specs, (s) => widths[s] ?? s.length * 6);
  (self as unknown as Worker).postMessage({ seq, places });
};
