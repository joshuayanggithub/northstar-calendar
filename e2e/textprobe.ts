// In-page probe for the overlap-layout laws.
//  blank:   a point inside a group of overlapping events that hits no event
//  text:    a text element (title line, time, location, cluster row)
//           that sticks out of its own event box or is under another box
//  noTime:  an event (not a cluster row) showing no time at all
//  notes:   a margin note (the red pen) that is cut off, sits on printed
//           text or on another note, leaves the grid, or whose arrow
//           doesn't reach its own event
import type { Page } from "@playwright/test";

export interface ProbeResult {
  blank: string[];
  text: string[];
  /** a block whose rows don't share one left edge, or a time row not
   *  directly under its title, or two rows on top of each other */
  align: string[];
  /** titles shown cut (clamped or ellipsized), as "title (WxH)" */
  cut: string[];
  noTime: { title: string; widthPx: number; heightPx: number }[];
  events: number;
  notes: string[];
  /** margin notes on the page */
  noteCount: number;
}

export async function probe(page: Page): Promise<ProbeResult> {
  return page.evaluate(probeInPage);
}

/** The probe itself: self-contained (no closures) so it can also be sent as
 *  source text to the real app window (e2e/realwindow.spec.ts). */
export async function probeInPage(): Promise<ProbeResult> {
  {
    const OWNER = ".chip-timed, .cluster-block";
    const TEXT = ".chip-title, .chip-time, .chip-time-inline, .chip-loc, .cluster-title";
    const blank = new Set<string>();
    const textOk = new Map<string, true | string>();
    const alignSeen = new Set<string>();
    const alignBad: string[] = [];
    const cutTitles: string[] = [];
    const timeSeen = new Map<string, { ok: boolean; w: number; h: number }>();
    const grid = document.querySelector<HTMLElement>("[data-testid=week-grid]")!;
    const label = (el: HTMLElement) =>
      (el.getAttribute("title") || el.querySelector(".chip-title")?.textContent || el.textContent || "")
        .replace(/\s+/g, " ")
        .slice(0, 48);
    const step = Math.max(200, grid.clientHeight - 220);
    for (let st = 0; ; st += step) {
      grid.scrollTop = st;
      // two frames, or a timer when frames are paused (a window behind
      // others); layout reads below are synchronous either way
      await new Promise<void>((r) => {
        let done = false;
        const go = () => {
          if (!done) {
            done = true;
            r();
          }
        };
        requestAnimationFrame(() => requestAnimationFrame(go));
        setTimeout(go, 50);
      });
      const gr = grid.getBoundingClientRect();
      const head = (grid.querySelector(".allday-row") as HTMLElement | null)?.getBoundingClientRect().bottom ?? gr.top;
      const lo = head + 2;
      const hi = gr.bottom - 2;
      const visible = (y: number) => y >= lo && y <= hi;
      for (const col of grid.querySelectorAll<HTMLElement>("[data-testid^=day-col-]")) {
        const cr = col.getBoundingClientRect();
        const day = col.dataset.testid;
        const owners = [...col.querySelectorAll<HTMLElement>(OWNER)];
        // ---- law 1: blank space inside overlap groups ----
        const boxes = owners
          .map((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
          .sort((a, b) => a.top - b.top);
        const groups: { top: number; bottom: number; n: number }[] = [];
        for (const b of boxes) {
          const g = groups[groups.length - 1];
          if (g && b.top < g.bottom - 0.5) {
            g.bottom = Math.max(g.bottom, b.bottom);
            g.n++;
          } else groups.push({ top: b.top, bottom: b.bottom, n: 1 });
        }
        for (const g of groups) {
          if (g.n < 2) continue;
          for (let y = g.top + 6; y < g.bottom - 6; y += 3) {
            if (!visible(y)) continue;
            for (const fx of [6, cr.width / 2, cr.width - 7]) {
              if (cr.left + fx > gr.right - 16) continue; // overlay scrollbar
              // looking through the margin notes: they may sit on bodies
              const hit = document
                .elementsFromPoint(cr.left + fx, y)
                .find((el) => !el.closest("[data-testid=margin-notes]")) as HTMLElement | undefined;
              if (!hit || !hit.closest(OWNER)) blank.add(`${day} y=${Math.round(y - cr.top)} x=${Math.round(fx)}`);
            }
          }
        }
        // ---- law 2: every text element inside its own box, nothing over it ----
        for (const owner of owners) {
          const ob = owner.getBoundingClientRect();
          const isCluster = owner.classList.contains("cluster-block");
          for (const t of owner.querySelectorAll<HTMLElement>(TEXT)) {
            const r = t.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            const key = `${day} | ${label(owner)} | .${t.className.split(" ")[0]} "${(t.textContent || "").slice(0, 28)}"`;
            if (textOk.get(key) === true) continue;
            if (!visible(r.top + 2) || !visible(r.bottom - 2)) continue; // judge when fully on screen
            let why: string | null = null;
            if (r.top < ob.top - 0.5 || r.bottom > ob.bottom + 0.5 || r.left < ob.left - 0.5 || r.right > ob.right + 0.5) {
              const span = (a: number, b: number, o: number) => `${Math.round(a - o)}..${Math.round(b - o)}`;
              why =
                `sticks out of its box (text y ${span(r.top, r.bottom, cr.top)} x ${span(r.left, r.right, cr.left)}, ` +
                `box y ${span(ob.top, ob.bottom, cr.top)} x ${span(ob.left, ob.right, cr.left)})`;
            }
            // a clipped time ("9:30 A…") misinforms: times are whole or absent
            const holder = t.parentElement;
            const row =
              holder && t !== holder && /chip-line|chip-title/.test(holder.className) && /chip-time/.test(t.className)
                ? holder.getBoundingClientRect()
                : null;
            if (
              !why &&
              row &&
              (r.right > row.right + 0.5 || r.left < row.left - 0.5 || r.bottom > row.bottom + 0.5 || r.top < row.top - 0.5)
            ) {
              why = `time clipped by its row (text x ${Math.round(r.left - cr.left)}..${Math.round(r.right - cr.left)} y ${Math.round(r.top - cr.top)}..${Math.round(r.bottom - cr.top)}, row x ..${Math.round(row.right - cr.left)} y ..${Math.round(row.bottom - cr.top)})`;
            }
            if (!why && /chip-time/.test(t.className)) {
              if (t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1) {
                why = `time truncated (${t.scrollWidth}x${t.scrollHeight} in ${t.clientWidth}x${t.clientHeight})`;
              }
            }
            if (!why) {
              // sample the ink (each line's glyph run), not the element's
              // box: a box can run on past its last word, and that blank
              // end is free for a margin note to use
              const rg = document.createRange();
              rg.selectNodeContents(t);
              const lines = [...rg.getClientRects()]
                .map((q) => ({
                  left: Math.max(q.left, r.left),
                  right: Math.min(q.right, r.right),
                  top: Math.max(q.top, r.top),
                  bottom: Math.min(q.bottom, r.bottom),
                }))
                .filter((q) => q.right - q.left > 3 && q.bottom - q.top > 3);
              outer: for (const q of lines.length ? lines : [r]) for (let y = q.top + Math.min(6, (q.bottom - q.top) / 2); y <= q.bottom - 2; y += 12) {
                for (const x of [q.left + 2, (q.left + q.right) / 2, q.right - 2]) {
                  // macOS overlay scrollbars float over the scroller's right
                  // edge for a moment after each scroll: system UI, not ours
                  if (x > gr.right - 16) continue;
                  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
                  const who = hit?.closest(OWNER) as HTMLElement | null;
                  if (who !== owner) {
                    why = `covered at y=${Math.round(y - cr.top)} by ${who ? label(who) : `nothing (clipped; hit ${hit ? hit.tagName.toLowerCase() + "." + String(hit.className).split(" ").join(".") : "none"} at ${Math.round(x)},${Math.round(y)} in ${innerWidth}x${innerHeight})`}`;
                    break outer;
                  }
                }
              }
            }
            textOk.set(key, why ?? true);
          }
          // ---- law 3: one neat block (same left edge, time row right under
          // the title, rows never on top of each other) ----
          if (!isCluster) {
            const k = `${day} | ${label(owner)}`;
            const rows = [...owner.querySelectorAll<HTMLElement>(".chip-title, .chip-line, .chip-time, .chip-loc")]
              .filter((el) => !el.classList.contains("chip-time-v"))
              .filter((el) => !el.parentElement?.closest(".chip-title, .chip-line"))
              .map((el) => ({ el, r: el.getBoundingClientRect() }))
              .filter(({ r }) => r.width >= 1 && r.height >= 1);
            if (rows.length && rows.every(({ r }) => visible(r.top + 1) && visible(r.bottom - 1)) && !alignSeen.has(k)) {
              alignSeen.add(k);
              const x0 = rows[0].r.left;
              const off = rows.find(({ r }) => Math.abs(r.left - x0) > 1.5);
              if (off) {
                alignBad.push(`${k} -> .${off.el.className.split(" ")[0]} starts at x ${Math.round(off.r.left - cr.left)}, title block at ${Math.round(x0 - cr.left)}`);
              }
              const ttl = rows.find(({ el }) => /chip-title|chip-line/.test(el.className));
              // the title opens the event: at its top, below a joint's step at most
              const ob2 = owner.getBoundingClientRect();
              if (ttl && ttl.r.top - ob2.top > 16) {
                alignBad.push(`${k} -> title starts ${Math.round(ttl.r.top - ob2.top)}px below the event's top`);
              }
              const trow = rows.find(({ el }) => el.classList.contains("chip-time"));
              if (ttl && trow && Math.abs(trow.r.top - ttl.r.bottom) > 1.5) {
                alignBad.push(`${k} -> time row at y ${Math.round(trow.r.top - cr.top)}, title ends at ${Math.round(ttl.r.bottom - cr.top)}`);
              }
              for (let i = 0; i < rows.length; i++) {
                for (let j = i + 1; j < rows.length; j++) {
                  const a = rows[i].r;
                  const b = rows[j].r;
                  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                  if (oy > 1.5 && ox > 1) {
                    alignBad.push(`${k} -> .${rows[i].el.className.split(" ")[0]} and .${rows[j].el.className.split(" ")[0]} overlap by ${Math.round(oy)}px`);
                  }
                }
              }
              const tt = owner.querySelector<HTMLElement>(":scope > .chip-title, :scope > .cfull-label > .chip-title, .chip-line > .chip-title");
              if (tt && (tt.scrollHeight > tt.clientHeight + 1 || tt.scrollWidth > tt.clientWidth + 1)) {
                cutTitles.push(`${k} (${Math.round(owner.getBoundingClientRect().width)}x${Math.round(owner.getBoundingClientRect().height)})`);
              }
            }
          }
          // ---- law 4: time presence (report) ----
          if (!isCluster) {
            const k = `${day} | ${label(owner)}`;
            const hasTime = [...owner.querySelectorAll<HTMLElement>(".chip-time, .chip-time-inline")].some(
              (s) => s.getBoundingClientRect().width > 4 && getComputedStyle(s).display !== "none",
            );
            const prev = timeSeen.get(k);
            timeSeen.set(k, { ok: (prev?.ok ?? false) || hasTime, w: ob.width, h: ob.height });
          }
        }
      }
      if (st + grid.clientHeight >= grid.scrollHeight) break;
    }
    // ---- law 5: margin notes (geometry only, so scroll doesn't matter) ----
    // they are placed off the main thread: wait for the latest placement
    for (let i = 0; i < 100 && grid.querySelector("[data-testid=margin-notes][data-pending='1']"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const notesBad: string[] = [];
    const noteEls = [...grid.querySelectorAll<HTMLElement>("[data-testid=margin-note]")];
    const layer = grid.querySelector<HTMLElement>("[data-testid=margin-notes]");
    const lr = layer?.getBoundingClientRect();
    const inkRects: { r: DOMRect; what: string }[] = [];
    for (const col of grid.querySelectorAll<HTMLElement>("[data-testid^=day-col-]")) {
      for (const t of col.querySelectorAll<HTMLElement>(TEXT + ", .chip-join")) {
        const box = t.getBoundingClientRect();
        const rg = document.createRange();
        rg.selectNodeContents(t);
        for (const r of rg.getClientRects()) {
          const x0 = Math.max(r.left, box.left);
          const x1 = Math.min(r.right, box.right);
          const y0 = Math.max(r.top, box.top);
          const y1 = Math.min(r.bottom, box.bottom);
          if (x1 - x0 > 1 && y1 - y0 > 1) inkRects.push({ r: new DOMRect(x0, y0, x1 - x0, y1 - y0), what: (t.textContent || "").slice(0, 24) });
        }
      }
    }
    const noteInk = (n: HTMLElement) =>
      [...n.querySelectorAll<HTMLElement>(".mn-line")].flatMap((ln) => {
        const rg = document.createRange();
        rg.selectNodeContents(ln);
        return [...rg.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      });
    const meet = (a: DOMRect, b: DOMRect, pad = 0) =>
      a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
    const inks = noteEls.map(noteInk);
    noteEls.forEach((n, i) => {
      const name = `"${(n.textContent || "").slice(0, 30)}"`;
      // whole: every line laid out in full, nothing hidden
      for (const ln of n.querySelectorAll<HTMLElement>(".mn-line")) {
        if (getComputedStyle(ln).overflow !== "visible" || getComputedStyle(n).overflow !== "visible") notesBad.push(`${name} can clip`);
      }
      if ((n.textContent || "").includes("…")) notesBad.push(`${name} is shortened`);
      // inside the grid
      if (lr) {
        const nb = n.getBoundingClientRect();
        if (nb.left < lr.left - 1 || nb.right > lr.right + 1 || nb.top < lr.top - 1 || nb.bottom > lr.bottom + 1) {
          notesBad.push(`${name} leaves the grid`);
        }
      }
      // never on printed text (the ink, rotated boxes included)
      for (const r of inks[i]) {
        const hit = inkRects.find((t) => meet(r, t.r));
        if (hit) {
          const f = (q: DOMRect) => `${Math.round(q.left)},${Math.round(q.top)}..${Math.round(q.right)},${Math.round(q.bottom)}`;
          notesBad.push(`${name} covers "${hit.what}" (note ink ${f(r)}, text ${f(hit.r)}, layer pending=${layer?.dataset.pending})`);
          break;
        }
      }
      // never on another note
      for (let j = i + 1; j < noteEls.length; j++) {
        if (inks[i].some((a) => inks[j].some((b) => meet(a, b)))) {
          notesBad.push(`${name} overlaps "${(noteEls[j].textContent || "").slice(0, 30)}"`);
        }
      }
      // tied to its own event: sitting on it, or an arrow that ends at it
      const ev = grid.querySelector<HTMLElement>(`.chip-timed[data-ek="${CSS.escape(n.dataset.ek!)}"], .cluster-row[data-ek="${CSS.escape(n.dataset.ek!)}"]`);
      if (!ev) {
        notesBad.push(`${name} has no event on the page`);
        return;
      }
      if (n.dataset.inside === "1") {
        const eb = ev.getBoundingClientRect();
        const nb = n.getBoundingClientRect();
        if (!meet(nb, eb, 2)) notesBad.push(`${name} says it sits on its event but doesn't`);
        return;
      }
      const leader = grid.querySelector<SVGGElement>(`[data-testid=margin-leader][data-ek="${CSS.escape(n.dataset.ek!)}"]`);
      const path = leader?.querySelector("path");
      if (!path) {
        const eb = ev.getBoundingClientRect();
        if (!meet(n.getBoundingClientRect(), eb, 8)) notesBad.push(`${name} has no arrow and isn't by its event`);
        return;
      }
      const end = (path as SVGPathElement).getPointAtLength((path as SVGPathElement).getTotalLength());
      const svg = (path as SVGPathElement).ownerSVGElement!.getBoundingClientRect();
      const ex = svg.left + end.x;
      const ey = svg.top + end.y;
      const eb = ev.getBoundingClientRect();
      if (ex < eb.left - 6 || ex > eb.right + 6 || ey < eb.top - 6 || ey > eb.bottom + 6) {
        notesBad.push(`${name} points at ${Math.round(ex - eb.left)},${Math.round(ey - eb.top)} from its event's corner, not at it`);
      }
    });
    grid.scrollTop = 0;
    return {
      notes: notesBad,
      noteCount: noteEls.length,
      blank: [...blank],
      align: alignBad,
      cut: cutTitles,
      text: [...textOk.entries()].filter(([, v]) => v !== true).map(([k, v]) => `${k} -> ${v}`),
      noTime: [...timeSeen.entries()]
        .filter(([, v]) => !v.ok)
        .map(([k, v]) => ({ title: k, widthPx: Math.round(v.w), heightPx: Math.round(v.h) })),
      events: timeSeen.size,
    };
  }
}
