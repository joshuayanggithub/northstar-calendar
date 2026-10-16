// Weekly Review: the Obsidian journal rendered in place. Checkbox toggles and
// appended entries write back to the real .md (CAS via mtime), so Obsidian
// and the calendar stay one source of truth.

import { useMemo, useState } from "react";
import { format, now } from "../lib/dates";
import { appendReviewEntry, parseBlocks, parseInline, toggleTaskLine } from "../lib/markdown";

function MdInline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((t, i) =>
        t.kind === "text" ? (
          <span key={i}>{t.text}</span>
        ) : t.kind === "wikilink" ? (
          <span key={i} className="md-wikilink" title={`[[${t.text}]] in Obsidian`}>
            {t.text}
          </span>
        ) : (
          <a key={i} href={t.href} target="_blank" rel="noreferrer" className="md-link">
            {t.text}
          </a>
        ),
      )}
    </>
  );
}
import { useMd } from "../lib/useMd";
import type { Backend } from "../lib/types";

export function ReviewView(props: { backend: Backend | null }) {
  const journal = useMd(props.backend, "journal");
  const [entry, setEntry] = useState("");
  const blocks = useMemo(() => parseBlocks(journal.content), [journal.content]);

  const addEntry = async () => {
    if (!entry.trim()) return;
    await journal.mutate((c) => appendReviewEntry(c, format(now(), "MMM d, yyyy"), entry));
    setEntry("");
  };

  return (
    <div className="reviewview" data-testid="review-view">
      <div className="review-doc">
        {journal.loading && <p className="panel-muted">Loading journal…</p>}
        {!journal.loading && !journal.exists && (
          <p className="panel-muted">
            Journal not found. Expected your Obsidian file at the configured path — it will appear
            here once the file exists.
          </p>
        )}
        {blocks.map((b) => {
          switch (b.type) {
            case "heading": {
              const Tag = (b.level ?? 1) <= 1 ? "h1" : b.level === 2 ? "h2" : "h3";
              return (
                <Tag key={b.line} className="review-h">
                  {b.text}
                </Tag>
              );
            }
            case "task":
              return (
                <label key={b.line} className="review-task" style={{ marginLeft: (b.indent ?? 0) * 8 }}>
                  <input
                    type="checkbox"
                    checked={b.checked}
                    onChange={() => journal.mutate((c) => toggleTaskLine(c, b.line))}
                  />
                  <span className={b.checked ? "done" : ""}>
                    <MdInline text={b.text} />
                  </span>
                </label>
              );
            case "bullet":
              return (
                <div key={b.line} className="review-bullet" style={{ marginLeft: (b.indent ?? 0) * 8 }}>
                  • <MdInline text={b.text} />
                </div>
              );
            case "ordered":
              return (
                <div key={b.line} className="review-bullet" style={{ marginLeft: (b.indent ?? 0) * 8 }}>
                  {b.marker} <MdInline text={b.text} />
                </div>
              );
            case "hr":
              return <hr key={b.line} className="review-hr" />;
            case "para":
              return (
                <p key={b.line} className="review-p">
                  <MdInline text={b.text} />
                </p>
              );
            default:
              return <div key={b.line} className="review-gap" />;
          }
        })}
      </div>

      <div className="review-compose">
        <textarea
          placeholder="Write this week's review… (appends to your Obsidian journal)"
          rows={3}
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          data-testid="review-entry"
        />
        <button className="btn btn-accent" onClick={addEntry} disabled={!entry.trim()}>
          Add entry
        </button>
      </div>
    </div>
  );
}
