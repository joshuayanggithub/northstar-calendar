// Tiny markdown utilities for the Obsidian journal: a minimal block model
// for the review view, with exact line indices so task toggles rewrite only
// their own line. No dependencies, no HTML injection.

export interface MdBlock {
  type: "heading" | "task" | "bullet" | "ordered" | "hr" | "para" | "blank";
  level?: number; // heading level
  line: number;
  text: string;
  checked?: boolean;
  indent?: number;
  marker?: string; // ordered-list marker, e.g. "3."
}

const TASK_RE = /^(\s*)[-*] \[([ xX])\] (.*)$/;
const BULLET_RE = /^(\s*)[-*] (?!\[)(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)[.)] (.*)$/;
const HR_RE = /^\s*-{3,}\s*$/;
const HEADING_RE = /^(#{1,6}) (.*)$/;

export function parseBlocks(content: string): MdBlock[] {
  return content.split("\n").map((line, i): MdBlock => {
    const h = line.match(HEADING_RE);
    if (h) return { type: "heading", level: h[1].length, line: i, text: h[2].trim() };
    const t = line.match(TASK_RE);
    if (t)
      return {
        type: "task",
        line: i,
        text: t[3].trim(),
        checked: t[2].toLowerCase() === "x",
        indent: t[1].length,
      };
    if (HR_RE.test(line)) return { type: "hr", line: i, text: "" };
    const b = line.match(BULLET_RE);
    if (b) return { type: "bullet", line: i, text: b[2].trim(), indent: b[1].length };
    const o = line.match(ORDERED_RE);
    if (o) return { type: "ordered", line: i, text: o[3].trim(), indent: o[1].length, marker: o[2] + "." };
    if (line.trim() === "") return { type: "blank", line: i, text: "" };
    return { type: "para", line: i, text: line };
  });
}

/** Flip exactly one task line; everything else byte-identical. */
export function toggleTaskLine(content: string, line: number): string {
  const lines = content.split("\n");
  const m = lines[line]?.match(TASK_RE);
  if (!m) return content;
  lines[line] = `${m[1]}- [${m[2].toLowerCase() === "x" ? " " : "x"}] ${m[3]}`;
  return lines.join("\n");
}

/** Append a dated review entry at the end of the file. */
export function appendReviewEntry(content: string, dateLabel: string, text: string): string {
  const base = content.endsWith("\n") ? content : content + "\n";
  return `${base}\n## Weekly Review — ${dateLabel}\n\n${text.trim()}\n`;
}

/** Inline tokens: [[wiki links]] and [text](url), everything else verbatim. */
export interface MdInlineTok {
  kind: "text" | "wikilink" | "link";
  text: string;
  href?: string;
}

export function parseInline(text: string): MdInlineTok[] {
  const out: MdInlineTok[] = [];
  const re = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] != null) out.push({ kind: "wikilink", text: m[1] });
    else out.push({ kind: "link", text: m[2], href: m[3] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

