# Local goal-work classification — design

Goal: events that advance the user's goals (sidebar, from the Obsidian goals
file) get recognized automatically, with zero cloud calls. The model
*suggests*; the user *ratifies*. A misclassification must never loudly
congratulate the user.

## Empirical grounding (2026-10-14, this Mac)

Ollama is installed and running with `gemma3:12b`. Probe: 12 real event
titles classified against the 5 real top-level goals, JSON-constrained,
temperature 0:

- **Accuracy 12/12**: research reading → the right research goal, career
  admin → the career goal, shopping / sports / lunch / showers / meal prep →
  null.
- **Latency 6–11 s per event** (22 s cold). Fine for a background queue;
  far too slow for anything interactive.
- A small model (`qwen2.5:0.5b` / `llama3.2:1b`, ~0.3–1 s) should be offered
  as the bulk path — pull on first enable, keep gemma as fallback quality
  tier. (Apple Foundation Models would be the zero-install path but needs a
  Swift bridge; revisit when tauri-plugin support exists.)

## Architecture

```
events (SQLite) ──► classify queue (Rust, background)
                      • candidates: events in [today-7, today+14] whose
                        (title, goals-hash) has no cache row
                      • prompt: numbered top-level goals + title
                        → {"goal": n | null, "confidence": "high"|"low"}
                      • writes goal_class(event_key PK, goal_text,
                        title_hash, goals_hash, confidence, at)
                      • triggers: app start, db-changed (debounced 30 s),
                        goals file change; one at a time, lowest priority
frontend ◄── get_goal_classifications(range) + "goal-class-changed" event
   merge rule: manual star entry ALWAYS wins (including explicit
   "not goal work" suppression) → else cache row with confidence=high
   → auto-star (hollow)
```

- **Cache key** includes a hash of the goals list: edit your goals and
  affected titles re-classify.
- **Recurring events** classify once per title, not per instance.
- **Privacy**: titles never leave the machine; Ollama is loopback.

## Trust & star semantics (tri-state)

| state | visual | counts toward |
|---|---|---|
| manual star (+goal link) | solid gold ★ | goal bars, day counter, full |
| auto-classified | hollow ☆, calm | bars at half-emphasis until confirmed |
| manual "not goal work" | nothing | suppresses future auto for that title |

Confirming an auto star (one click on ☆, or `Y` in a future reconcile
flow) upgrades it to manual. The stars store gains `auto: boolean` and an
explicit suppression entry instead of delete-on-clear.

## Goal list extraction (shipped now)

`goalLines()` in `markdown.ts`: top-level checkbox tasks **and** top-level
numbered items under each h1/h2 — the user's real file is a numbered
outline with almost no checkboxes, so task-only parsing produced an empty
goal list. Panel dropdown, sidebar badges and the classifier all share it.

## Not doing

- No generation/rewriting of titles; classification only.
- No cloud fallback of any kind.
- No auto-linking to sub-items (leaf bullets) — top-level goals only, to
  keep the label space small and the model reliable.
