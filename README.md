<h1 align="center">North Star</h1>

<p align="center">
  <img src="design/icon/north-star-1024.png" width="80" alt="The North Star app icon: the Little Dipper drawn across a month page, ending at a red today square crowned by a gold north star">
</p>

<p>northstar is a rust-based, macOS, dekstop calendar app that centers around features maximizing your <b>north star</b>: long-term goals and productivity! the most popular calendar (gcal, notion) apps are</p>

<ol>
  <li><b>lacking basic UI/UX features</b> that help when scheduling lots of events</li>
  <li>lack true features that <em>enable long-term planning</em> and reflection of goals.</li>
</ol>

<p align="center">
  <a href="#a-uiux-upgrades">UI/UX Upgrades</a> · <a href="#b-productivity-add-ons">Productivity add-ons</a> · <a href="#implementation">Implementation</a>
</p>

<p align="center">
  <img src="docs/media/northstar.gif" width="800" alt="A one-minute walkthrough on a made-up week: yesterday is reconciled (✓ on one event, then Review for the rest); notes in the margins critique the week, and one more is added to an event and dragged into place; Saturday is planned (a writing block forms a rabbet joint with a swim and a C-shape around a call); three quick tasks collapse into one clustered list">
</p>

## A. UI/UX Upgrades

### 1. Overlapped Events

In google calendar its really hard to read overlapped events. Its a really simple fix of ensuring that overlapped events never add horizontal whitespace or random innents and clustering small-length events together in a more readable format.

<p align="center">
  <img src="docs/media/overlap-cshape.png" width="350" alt="North Star: a C-shape, the events inside a longer one sitting inside it">
  <img src="docs/media/overlap-cshape-gcal.png" width="350" alt="Google Calendar: the same events in side-by-side columns">
  <br>
  <img src="docs/media/overlap-rabbet.png" width="350" alt="North Star: a rabbet joint, two partly overlapping events interlocking">
  <img src="docs/media/overlap-rabbet-gcal.png" width="350" alt="Google Calendar: the same events in side-by-side columns">
  <br>
  <img src="docs/media/overlap-cluster.png" width="350" alt="North Star: a burst of short tasks clustered into one list">
  <img src="docs/media/overlap-cluster-gcal.png" width="350" alt="Google Calendar: the same events in side-by-side columns">
</p>

## B. Productivity add-ons

### 1. Reconcile Events

It's pretty common that you get lazy and forget to delete events that didn't happen -  by default, events are now dotted lines (didn't happen) and you have to manually "reconcile" events to mark events that happened or didn't.

<p align="center">
  <img src="docs/media/reconcile.png" width="800" alt="Wednesday to Friday: Wednesday's events are still dotted (unconfirmed); hovering one shows ✓ and ✕; the reminder at the bottom reads &quot;Yesterday: 6 unconfirmed events&quot; with Confirm all / Review">
  <br><sub>Yesterday's events stay dotted until you confirm them: ✓ or ✕ on each, or Review them one at a time.</sub>
</p>

### 2. Annotations for reflection

Annotations are used in literature to critique writing, so why not apply this to your life? Let's imagine you printed your calendar this week and annotated your calendar do determine how well you accomplished your goals / what went wrong?

<p align="center">
  <img src="docs/media/annotations.png" width="800" alt="A week with red handwritten notes in the free space around the events, with arrows to the events they critique">
  <br><sub>Notes in the week's margins, each with an arrow to its event.</sub>
</p>

### 3. Focus score / Highlighted Events / Goal dashboard

Some cool small features that help [prime](https://en.wikipedia.org/wiki/Priming_%28psychology%29) oneself to be more self-critical and evaluative of their goals? are a focus score that ranks deep work and. highlighting goal-driven events with pretty ui animations, and goal dashboard.  

<p align="center">
  <img src="docs/media/focus-goals.png" width="800" alt="Tuesday to Thursday with the sidebar open: Tuesday's focus score explained, Thursday's goal-work block with its gold light, and the goal dashboard with daily, weekly and long-term goals">
  <br><sub>Tuesday's focus score explained · Thursday's goal work highlighted · the goal dashboard in the sidebar.</sub>
</p>


## Implementation

northstar is a [Tauri 2](https://tauri.app/) app: a Rust core and a React + TypeScript interface in the system's WebKit view. It is local-first. Events live in a local SQLite database and sync both ways with Google Calendar; the goal classification comes from a local model (via [Ollama](https://ollama.com/)), so nothing else leaves the machine.

- **Sync core** ([`crates/sync-core`](crates/sync-core), Rust): the SQLite store and the Google Calendar client. Incremental sync with sync tokens (a 410 triggers a full resync), writes guarded by ETags (`If-Match`; on a 412 the remote copy wins), echo suppression for its own writes, and the OAuth refresh token kept in the macOS keychain.
- **App shell** ([`src-tauri`](src-tauri)): the commands the interface calls (events, calendars, goals), the sync thread, the menu bar item, and the goal classifier ([`classify.rs`](src-tauri/src/classify.rs)), which can ask a local model which events served a goal (switched off for now).
- **Interface** ([`src`](src)): the week/day, month, agenda and insights views. The layout work is pure TypeScript in [`src/lib`](src/lib):
  - [`layout.ts`](src/lib/layout.ts) packs overlapping events into C-shapes, rabbet joints and clusters, never leaving horizontal gaps;
  - [`labelPlace.ts`](src/lib/labelPlace.ts) places each event's title and time inside the part of its shape that stays visible;
  - [`marginNotes.ts`](src/lib/marginNotes.ts) places annotations in free space with arrows back to their events: a candidate search over a summed-area table of the page, then simulated annealing, in a Web Worker;
  - [`insights.ts`](src/lib/insights.ts) computes the focus score ([design notes](design/focus-score.md)), [`recon.ts`](src/lib/recon.ts) reconciliation, [`goals.ts`](src/lib/goals.ts) goals.
- **Tests** ([`e2e`](e2e)): Playwright drives the interface against an in-browser mock backend, and the real WebKit window through a debug-only test hook plus WebDriver. Layout rules (no covered text, no blank gaps inside overlaps, annotations whole and tied to their event) are checked on synthetic weeks and on real ones.

```mermaid
flowchart LR
  subgraph UI["Interface: React + TypeScript (WebKit)"]
    V["Week / Month / Agenda / Insights views"]
    L["Layout engines<br/>layout.ts · labelPlace.ts<br/>marginNotes.ts (Web Worker)"]
    S["Focus score · reconcile · goals<br/>insights.ts · recon.ts · goals.ts"]
  end
  subgraph Shell["App shell: Tauri 2 (Rust)"]
    C["Commands"]
    T["Menu bar item"]
    SUP["Classifier<br/>goal classification"]
  end
  subgraph Core["sync-core (Rust)"]
    DB[("SQLite")]
    SY["Two-way sync engine"]
  end
  V --> L
  V --> S
  V <-->|"invoke / events"| C
  C --> DB
  T --> DB
  SY <--> DB
  SY <-->|"Calendar API"| G[("Google Calendar")]
  K[("macOS keychain")] --- SY
  SUP --> DB
  SUP <-->|"local model"| O[("Ollama")]
```
