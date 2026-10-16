// The drill-sergeant's red-pen line lives INSIDE the event description behind
// a [DRILL] marker (so it syncs through Google like any field). The UI splits
// it out: the editor shows the clean body, the chip wears the scrawl.

export const DRILL_MARK = "[DRILL]";

export function splitDrill(description: string | null | undefined): {
  body: string;
  drill: string | null;
} {
  if (!description) return { body: "", drill: null };
  const lines = description.split("\n");
  const drillLine = lines.find((l) => l.trim().startsWith(DRILL_MARK));
  const body = lines
    .filter((l) => !l.trim().startsWith(DRILL_MARK))
    .join("\n")
    .replace(/\n+$/, "");
  return {
    body,
    drill: drillLine ? drillLine.trim().slice(DRILL_MARK.length).trim() : null,
  };
}

export function joinDrill(body: string, drill: string | null): string {
  const b = body.replace(/\n+$/, "");
  if (!drill) return b;
  return b ? `${b}\n\n${DRILL_MARK} ${drill}` : `${DRILL_MARK} ${drill}`;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The note as it should read. The model sometimes wraps its line in stage
 *  directions ("**[Red marker scribble in margin next to X]**",
 *  "**Calendar Entry: X**") or repeats the event's title first; those go.
 *  *Emphasis* marks stay (they render as the pen's underline). Returns null
 *  when nothing but the stage direction was there. */
export function cleanDrill(raw: string | null | undefined, title = ""): string | null {
  if (!raw) return null;
  let s = raw.replace(/\s+/g, " ").trim();
  const scene = /(red\s+(marker|pen|ink)|margin|scrawl|scribbl|calendar\s+(entry|event))/i;
  for (let i = 0; i < 3; i++) {
    const before = s;
    // **[…]** / **(…)** / **Calendar Entry: …** headers
    s = s.replace(/^\*\*\s*([[(][^\])]*[\])]|[^*]*)\s*\*\*\s*/, (m, inner: string) => (scene.test(inner) ? "" : m));
    // unbolded [ … ] / ( … ) stage directions
    s = s.replace(/^[[(]([^\])]*)[\])]\s*/, (m, inner: string) => (scene.test(inner) ? "" : m));
    s = s.replace(/^(\*\*\s*)?calendar\s+(entry|event)\s*:\s*/i, "");
    // the event's title said again
    const t = norm(title);
    if (t && norm(s).startsWith(t)) {
      let i2 = 0;
      let matched = 0;
      while (i2 < s.length && matched < t.length) {
        if (/\s/.test(s[i2]) && (matched === 0 || t[matched] !== " ")) {
          i2++;
          continue;
        }
        if (s[i2].toLowerCase() === t[matched]) matched++;
        i2++;
      }
      s = s.slice(i2).replace(/^\s*(\*\*)?\s*[:\-–—]?\s*/, "");
    }
    s = s.trim();
    if (s === before) break;
  }
  // a note entirely in *italics* reads as plain
  const whole = s.match(/^\*([^*]+)\*$/);
  if (whole) s = whole[1].trim();
  s = s.replace(/^\*\*\s*\*\*\s*/, "").trim();
  if (!s || /^[*.…\s]*$/.test(s)) return null;
  return s;
}
