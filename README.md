# Main
northstar is a mac dekstop calendar app that centers around features maximizing your north star: long-term goals and productivity! the most popular calendar (gcal, notion) apps are 1. basic clunky - lacking basic UI/UX features that help when scheduling lots of events 2. lack true features that enable long-term planning and reflection of goals. 

![northstar in ten seconds: a week of a made-up calendar, reconciling events, annotations, and the focus score](docs/media/northstar.gif)

<sub>10 seconds, made with [Remotion](https://www.remotion.dev/) (source in [`video/`](video)) · [mp4](docs/media/northstar.mp4) · every image on this page is a made-up demo week (Rosa, a freelance writer; [`scripts/readme`](scripts/readme))</sub>

# Productivity add-ons
1. Reconcile Events
It's pretty common that you get lazy and forget to delete events that didn't happen -  by default, events are now dotted lines (didn't happen) and you have to manually "reconcile" events to mark events that happened or didn't.

   ![Yesterday in day view: the events are still dotted (unconfirmed); hovering one shows ✓ and ✕; the reminder at the bottom reads "Yesterday: 6 unconfirmed events" with Confirm all / Review](docs/media/reconcile.png)

3. Annotations for reflection

Annotations are used in literature to criticque writing, so why not apply this to your life? Let's imagine you printed your calendar this week and hired your pessimistic alter-ego to determine how well you accomplished your goals / what went wrong? 

Self-reflection is a core component of [weekly/daily reviews](https://substack.com/home/post/p-219365768). This makes weekly reviews easy rather than staring at a hard-to-look-at colorful mess of events .

![A week with red handwritten notes in the free space around the events, with arrows to the events they critique](docs/media/annotations.png)

3. Focus score / Highlighted Events / Goal dashboard
What feature might [prime](https://en.wikipedia.org/wiki/Priming_%28psychology%29) oneself to be more self-critical and evaluative of their goals? 1. A focus score that ranks deep work and 2. highlighted events with pretty ui animations to make goal-driven events stand out 3. goal dashboard to keep driven 

![Three columns: the focus score's breakdown for a day; a goal-work event with its gold light running along the outline; the goal dashboard with daily, weekly and long-term goals](docs/media/focus-goals.png)

# UI/UX Improvements
1. Overlapped Events
In google calendar its really hard to read overlapped events. Its a really simple fix of ensuring that overlapped events never add horizontal whitespace or random innents and clustering small-length events together in a more readable format.

![northstar: C-shape invariance, rabbet joint, clustered view](docs/media/overlaps.png)
![The same events laid out the way Google Calendar does: side-by-side columns with cut-off titles](docs/media/overlaps-gcal.png)
  
# Implementation
northstar is a [Tauri 2](https://tauri.app/) app: a Rust core and a React + TypeScript interface in the system's WebKit view. It is local-first. Events live in a local SQLite database and sync both ways with Google Calendar; the goal classification and the annotations come from a local model (via [Ollama](https://ollama.com/)), so nothing else leaves the machine.

- **Sync core** ([`crates/sync-core`](crates/sync-core), Rust): the SQLite store and the Google Calendar client. Incremental sync with sync tokens (a 410 triggers a full resync), writes guarded by ETags (`If-Match`; on a 412 the remote copy wins), echo suppression for its own writes, and the OAuth refresh token kept in the macOS keychain.
- **App shell** ([`src-tauri`](src-tauri)): the commands the interface calls (events, calendars, goals, the journal), the sync thread, the menu bar item, and the supervisor ([`classify.rs`](src-tauri/src/classify.rs)) that asks the local model which events served a goal and writes the reflection notes.
- **Interface** ([`src`](src)): the week/day, month, agenda, insights and review views. The layout work is pure TypeScript in [`src/lib`](src/lib):
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
    SUP["Supervisor<br/>goal classification · annotations"]
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
