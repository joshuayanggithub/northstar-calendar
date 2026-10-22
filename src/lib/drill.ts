// Your red-pen note lives INSIDE the event description behind
// a [DRILL] marker (so it syncs through Google like any field). The UI splits
// it out: the editor shows the clean body, the chip wears the scrawl.

export const DRILL_MARK = "[DRILL]";

export function splitDrill(description: string | null | undefined): {
  body: string;
  drill: string | null;
} {
  if (!description) return { body: "", drill: null };
  let lines = description.split("\n");
  // Google web saves descriptions as HTML: the note's line can follow a <br>
  // or sit in its own <p>/<span> (split there only when that's where the
  // note is: an untouched HTML description must round-trip as it was)
  // (the plain pass reads lines as written: a one-line HTML description
  // starting with the note read whole as the note, body and all)
  if (!lines.some((l) => l.trim().startsWith(DRILL_MARK))) {
    const html = description.replace(/<br\s*\/?>|<\/?(?:p|div)\b[^>]*>/gi, "\n").split("\n");
    if (html.some(isNoteLine)) lines = html;
  }
  const drillLine = lines.find(isNoteLine);
  const body = lines
    .filter((l) => !isNoteLine(l))
    .join("\n")
    // (the HTML path's opening <p> left an empty first line)
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return {
    body,
    // (as text: Google escapes & and quotes, and wraps formatted runs in tags)
    drill: drillLine ? decodeEntities(bare(drillLine).slice(DRILL_MARK.length).trim()) : null,
  };
}

/** a line without its tags (real ones: "keep it < 30 min, > 10 pages" in a
 *  plain note lost the words between) */
const bare = (l: string) => l.replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "").trim();
const isNoteLine = (l: string) => bare(l).startsWith(DRILL_MARK);
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function joinDrill(body: string, drill: string | null): string {
  const b = body.replace(/\n+$/, "");
  if (!drill) return b;
  return b ? `${b}\n\n${DRILL_MARK} ${drill}` : `${DRILL_MARK} ${drill}`;
}

/** The note as it reads: whitespace collapsed, and a stage direction the
 *  old drill-sergeant model wrapped its lines in ("**[Red marker scribble
 *  in margin…]**", "**Calendar Entry: …**") taken off. Nothing else: the
 *  title strip it also did cut your own notes ("Gymnastics…" under "Gym"
 *  became "nastics…", and Save stored that). */
export function cleanDrill(raw: string | null | undefined, _title = ""): string | null {
  if (!raw) return null;
  let s = raw.replace(/\s+/g, " ").trim();
  const scene = /(red\s+(marker|pen|ink)|margin|scrawl|scribbl|calendar\s+(entry|event))/i;
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/^\*\*\s*([[(][^\])]*[\])]|[^*]*)\s*\*\*\s*/, (m, inner: string) => (scene.test(inner) ? "" : m));
    s = s.replace(/^[[(]([^\])]*)[\])]\s*/, (m, inner: string) => (scene.test(inner) ? "" : m));
    s = s.replace(/^(\*\*\s*)?calendar\s+(entry|event)\s*:\s*/i, "");
    s = s.trim();
    if (s === before) break;
  }
  return s || null;
}
