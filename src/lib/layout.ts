// Column-packing for overlapping timed events within one day column.
// Classic algorithm: cluster mutually-overlapping runs, assign each event the
// leftmost free column, width = 1/columns-in-cluster, slight cascade overlap.

export interface Positioned<T> {
  item: T;
  top: number; // px
  height: number; // px
  leftPct: number; // 0-100
  widthPct: number; // 0-100
}

interface Timed<T> {
  item: T;
  startMin: number;
  endMin: number;
}

export function packDay<T>(
  items: { item: T; startMin: number; endMin: number }[],
  pxPerMin: number,
  minHeightPx = 17,
): Positioned<T>[] {
  const sorted: Timed<T>[] = [...items].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
  );
  const out: Positioned<T>[] = [];
  let cluster: Timed<T>[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    // assign columns
    const colEnds: number[] = [];
    const colOf = new Map<Timed<T>, number>();
    for (const ev of cluster) {
      let col = colEnds.findIndex((end) => end <= ev.startMin);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(ev.endMin);
      } else {
        colEnds[col] = ev.endMin;
      }
      colOf.set(ev, col);
    }
    const nCols = colEnds.length;
    for (const ev of cluster) {
      const col = colOf.get(ev)!;
      // Notion-style slight overlap cascade: columns overlap ~8% for density.
      const w = nCols === 1 ? 100 : 100 / nCols + (col < nCols - 1 ? 8 : 0);
      out.push({
        item: ev.item,
        top: ev.startMin * pxPerMin,
        height: Math.max((ev.endMin - ev.startMin) * pxPerMin, minHeightPx),
        leftPct: (100 / nCols) * col,
        widthPct: Math.min(w, 100 - (100 / nCols) * col),
      });
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const ev of sorted) {
    const visEnd = Math.max(ev.endMin, ev.startMin + minHeightPx / pxPerMin);
    if (cluster.length === 0 || ev.startMin < clusterEnd) {
      cluster.push(ev);
      clusterEnd = Math.max(clusterEnd, visEnd);
    } else {
      flush();
      cluster.push(ev);
      clusterEnd = visEnd;
    }
  }
  flush();
  return out;
}

export interface ContainerLayout<T> {
  item: T;
  /** nesting depth: inset = depth * SLEEVE_LANE_WIDTH */
  lane: number;
  /** VISUAL box (a joint may move a slab's top/bottom off its exact times) */
  top: number;
  height: number;
  /** joint extents (px) at the top / bottom edge — see packDayWithSleeves */
  seamTopPx: number;
  seamBottomPx: number;
  /** where each joint steps across (px from the box's left), null: halfway */
  seamTopStepPx: number | null;
  seamBottomStepPx: number | null;
  /** paint order within the day column (later placed = higher) */
  z: number;
}

export interface ClusterBlock<T> {
  top: number;
  height: number;
  startMin: number;
  endMin: number;
  /** a cluster enclosed by a longer event sits inside it like any child */
  insetPx: number;
  items: { item: T; startMin: number; endMin: number }[];
  z: number;
}

export interface SleevePacked<T> {
  /** background slabs: events that enclose others (the C-shape) */
  containers: ContainerLayout<T>[];
  /** everything else; top/height are the VISUAL box, seams are joint extents */
  regular: (Positioned<T> & {
    insetPx: number;
    seamTopPx: number;
    seamBottomPx: number;
    seamTopStepPx: number | null;
    seamBottomStepPx: number | null;
    z: number;
  })[];
  /** dense cascades of small events, merged into one block of rows */
  clusters: ClusterBlock<T>[];
  laneCount: number;
}

const SLEEVE_LANE_PX = 20; // left strip revealed under a nested event

export const SLEEVE_LANE_WIDTH = SLEEVE_LANE_PX;

/** one title line + padding: the smallest band a label may occupy */
export const LABEL_PX = 17;
/** visible height of a joint's step */
const JOINT_PX = 12;

/** Layered overlap layout. Two rules, never columns:
 *  - C-SHAPE for true enclosure: an event that fully contains another is a
 *    quiet full-width slab; what it contains paints on top, inset 20px/depth.
 *    Because a child is always inside its slab's span, the slab's strip is
 *    behind it the whole way — no blank space.
 *  - JOINT for every partial overlap (same depth, chip↔chip or chip↔slab):
 *    the pair meets in a short step (rabbet/scarf, drawn by the view) placed
 *    inside the overlap but shifted so BOTH events keep a full-width band for
 *    their title. Each event's visual box ends/starts at the joint, so the
 *    pair tiles the column with nothing blank and nothing covered.
 *  Labels: every event keeps a title band at its top (below a top joint's
 *  step) that nothing later covers; where the text actually goes inside the
 *  visible shape is lib/labelPlace.ts's job. Pass joints=false for the plain
 *  overlay mode. */
export function packDayWithSleeves<T>(
  items: { item: T; startMin: number; endMin: number }[],
  pxPerMin: number,
  minHeightPx = 17,
  joints = true,
  /** label band an event asks for (px) at a given inset: LABEL_PX for one
   *  row, more for wrapped title lines and a time row. Granted up to the
   *  event's own height; a container pushes what it encloses below it. */
  labelPx?: (item: T, insetPx: number) => number,
): SleevePacked<T> {
  type It = { item: T; startMin: number; endMin: number };
  let arr: It[] = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Dense tangles are unreadable no matter how they nest: transitive-overlap
  // components among non-long events whose members get under ~20px of
  // vertical room each merge into ONE block that lists them as rows.
  const LONG_MIN = 90;
  const CLUSTER_MIN = 3;
  const ROOM_PX = 20;
  const ROW_PX = 15;
  const clusters: ClusterBlock<T>[] = [];
  {
    const shorts = arr.filter((e) => e.endMin - e.startMin < LONG_MIN);
    let comp: It[] = [];
    let compEnd = -Infinity;
    const flushComp = () => {
      if (comp.length >= CLUSTER_MIN) {
        const startMin = comp[0].startMin;
        const endMin = Math.max(...comp.map((c) => c.endMin));
        const spanPx = (endMin - startMin) * pxPerMin;
        if (spanPx / comp.length < ROOM_PX) {
          clusters.push({
            startMin,
            endMin,
            top: startMin * pxPerMin,
            height: Math.max(spanPx, comp.length * ROW_PX + 6),
            insetPx: 0,
            items: comp,
            z: 0,
          });
          const inComp = new Set(comp);
          arr = arr.filter((e) => !inComp.has(e));
        }
      }
      comp = [];
      compEnd = -Infinity;
    };
    for (const e of shorts) {
      if (comp.length && e.startMin >= compEnd) flushComp();
      comp.push(e);
      compEnd = Math.max(compEnd, e.endMin);
    }
    flushComp();
  }

  const idx = new Map(arr.map((e, i) => [e, i]));
  /** C-shape relation: o fully encloses e (identical intervals: first wins,
   *  which makes duplicates stack like cards) */
  const contains = (o: It, e: It) =>
    o !== e &&
    o.startMin <= e.startMin &&
    o.endMin >= e.endMin &&
    (o.endMin - o.startMin > e.endMin - e.startMin || idx.get(o)! < idx.get(e)!);

  // containment depth; arr is start-asc / end-desc so encloser precedes
  const depth = new Map<It, number>();
  for (const e of arr) {
    let d = 0;
    for (const o of arr) {
      if (o === e) break;
      if (contains(o, e)) d = Math.max(d, (depth.get(o) ?? 0) + 1);
    }
    depth.set(e, d);
  }
  // clusters sit inside the deepest event that encloses their whole span
  const clusterEncloser = clusters.map((c) => {
    let best: It | null = null;
    for (const o of arr) {
      if (o.startMin <= c.startMin && o.endMin >= c.endMin) {
        if (!best || depth.get(o)! > depth.get(best)!) best = o;
      }
    }
    return best;
  });
  clusters.forEach((c, i) => {
    const enc = clusterEncloser[i];
    c.insetPx = enc ? (depth.get(enc)! + 1) * SLEEVE_LANE_PX : 0;
  });
  const enclosesCluster = new Set(clusterEncloser.filter((x): x is It => !!x));
  const isSlab = (e: It) => enclosesCluster.has(e) || arr.some((x) => contains(e, x));

  // ---- single monotone placement pass ----
  // Every event (and cluster block) is placed ONCE, depth-first: an event,
  // then everything it encloses, then the next event in reading order (start
  // ascending, longer first). So an enclosing event is placed before what it
  // contains, and its final extent is settled before anything outside it is
  // placed. Paint order IS placement order (z = rank): whatever is placed
  // later paints above, which keeps every earlier title band uncovered by
  // construction. A placement only consults already-placed boxes and only
  // ever moves the new box DOWN, so it terminates (an earlier iterative
  // repair loop could chase itself down the day).
  // Constraints for the box being placed:
  //  (a) below the title band of every event that encloses it (C-shape:
  //      a slab's title sits at its top, children start beneath it);
  //  (c) never painted OVER an already-placed title band;
  //  (d) a partial overlap with the previous same-depth event becomes a
  //      joint whose step starts below that event's title band.
  // Boxes are as drawn: min height counts, so touching-but-tiny events that
  // overlap on screen are resolved like any other overlap.

  type Node = {
    it: It | null; // null for a cluster block
    c: ClusterBlock<T> | null;
    startMin: number;
    endMin: number;
    rank: number;
    depth: number;
    T: number; // visual top
    B: number; // visual bottom
    jt: number; // top joint step (px)
    jb: number; // bottom joint step (px)
    jtx: number | null; // where the top joint steps across (px from the left; null: halfway)
    jbx: number | null; // likewise the bottom joint
    slab: boolean;
  };
  let nodes: Node[] = [
    ...arr.map((it) => ({
      it,
      c: null,
      startMin: it.startMin,
      endMin: it.endMin,
      rank: 0,
      depth: depth.get(it)!,
      T: 0,
      B: 0,
      jt: 0,
      jb: 0,
      jtx: null,
      jbx: null,
      slab: isSlab(it),
    })),
    ...clusters.map((c, i) => ({
      it: null,
      c,
      startMin: c.startMin,
      endMin: c.endMin,
      rank: 0,
      depth: clusterEncloser[i] ? depth.get(clusterEncloser[i]!)! + 1 : 0,
      T: 0,
      B: 0,
      jt: 0,
      jb: 0,
      jtx: null,
      jbx: null,
      slab: false,
    })),
  ];
  nodes.sort(
    (a, b) =>
      a.startMin - b.startMin ||
      b.endMin - a.endMin ||
      (a.it ? 0 : 1) - (b.it ? 0 : 1) ||
      (a.it && b.it ? idx.get(a.it)! - idx.get(b.it)! : 0),
  );
  const nodeOf = new Map<It, Node>();
  for (const n of nodes) if (n.it) nodeOf.set(n.it, n);
  const ancestorsOf = (n: Node): Node[] =>
    arr
      .filter((o) =>
        n.it ? contains(o, n.it) : o.startMin <= n.startMin && o.endMin >= n.endMin,
      )
      .map((o) => nodeOf.get(o)!);
  const isAncestor = (a: Node, b: Node) =>
    !!a.it && (b.it ? contains(a.it, b.it) : a.it.startMin <= b.startMin && a.it.endMin >= b.endMin);
  // depth-first order: each node hangs under its deepest encloser (ties: the
  // later one, whose title it sits beneath)
  {
    const pos = new Map(nodes.map((n, i) => [n, i]));
    const kids = new Map<Node | null, Node[]>();
    for (const n of nodes) {
      let parent: Node | null = null;
      for (const a of ancestorsOf(n)) {
        if (!parent || a.depth > parent.depth || (a.depth === parent.depth && pos.get(a)! > pos.get(parent)!)) {
          parent = a;
        }
      }
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent)!.push(n);
    }
    const order: Node[] = [];
    const visit = (p: Node | null) => {
      for (const k of kids.get(p) ?? []) {
        order.push(k);
        visit(k);
      }
    };
    visit(null);
    nodes = order;
    nodes.forEach((n, i) => (n.rank = i));
  }
  const bandPx = new Map<Node, number>();
  for (const n of nodes) {
    let b = LABEL_PX;
    if (n.it && labelPx) {
      // the block it asks for, or as much of it as the event is tall
      const want = labelPx(n.it.item, n.depth * SLEEVE_LANE_PX);
      if (want > LABEL_PX) b = Math.max(LABEL_PX, Math.min(want, (n.endMin - n.startMin) * pxPerMin));
    }
    bandPx.set(n, b);
  }
  const minHeight = (n: Node) =>
    n.c ? ROW_PX * n.c.items.length + 6 : Math.max(minHeightPx, LABEL_PX);
  // A slab whose enclosed events start right at its top (the tail of an
  // event that ran past midnight, under a sleep that starts at midnight)
  // writes its title BELOW them, in the first open stretch of it that can
  // hold the band, so they keep their true start instead of being pushed
  // down under its title. lowBand: where that band starts (natural px).
  const lowBand = new Map<Node, number>();
  for (const n of nodes) {
    if (!n.slab || !n.it) continue;
    const band = bandPx.get(n)!;
    const inside = nodes.filter((k) => k !== n && isAncestor(n, k));
    let y = n.startMin * pxPerMin;
    for (let moved = true; moved; ) {
      moved = false;
      for (const k of inside) {
        const k0 = k.startMin * pxPerMin;
        const k1 = Math.max(k.endMin * pxPerMin, k0 + minHeight(k));
        if (k0 < y + band - 0.5 && k1 > y + 0.5) {
          y = k1;
          moved = true;
        }
      }
    }
    if (y > n.startMin * pxPerMin + 0.5 && y + band <= n.endMin * pxPerMin + 0.5) lowBand.set(n, y);
  }
  /** a low band's events above it (they start before it) */
  const aboveBand = (a: Node, k: Node) => lowBand.has(a) && k.startMin * pxPerMin < lowBand.get(a)! - 0.5;
  const placed: Node[] = [];
  // title band (cluster: its whole body is content that must stay visible);
  // a low band sits under whatever of the slab's own events lie above it,
  // wherever they ended up
  const bandOf = (n: Node): [number, number] => {
    if (n.c) return [n.T, n.B];
    const low = lowBand.get(n);
    if (low === undefined) return [n.T + n.jt, Math.min(n.T + n.jt + bandPx.get(n)!, n.B)];
    let top = Math.max(n.T + n.jt, low);
    for (const k of placed) if (k !== n && isAncestor(n, k) && aboveBand(n, k)) top = Math.max(top, k.B);
    return [top, top + bandPx.get(n)!];
  };

  for (const n of nodes) {
    const natural = n.startMin * pxPerMin;
    const natH = Math.max((n.endMin - n.startMin) * pxPerMin, minHeight(n));
    const ancestors = ancestorsOf(n);
    n.T = natural;
    let partner: Node | null = null;
    for (let guard = 0; guard < 200; guard++) {
      const before = n.T;
      // (a) beneath every enclosing event's title band (a low band: clear
      // of it, the events above it keeping their place)
      for (const a of ancestors) {
        if (aboveBand(a, n)) continue;
        const [ba, bb] = bandOf(a);
        if (!lowBand.has(a) || (n.T < bb - 0.5 && n.T + natH > ba + 0.5)) n.T = Math.max(n.T, bb);
      }
      // the box as it would be drawn at this top
      n.jt = 0;
      n.jtx = null;
      n.B = Math.max(n.endMin * pxPerMin, n.T + natH - Math.max(0, n.T - natural));
      n.B = Math.max(n.B, n.T + minHeight(n));
      // (d) joint with the previous overlapping same-depth event — chip or
      // slab on either side (a chip running into a slab gets the rounded
      // step too)
      partner = null;
      if (joints && n.it) {
        for (const p of placed) {
          if (!p.it || p.depth !== n.depth || isAncestor(p, n)) continue;
          if (p.B <= n.T + 0.5) continue;
          if (!partner || p.T > partner.T) partner = p;
        }
        if (partner) {
          const ov = partner.B - n.T;
          const J = ov >= 3 ? Math.min(ov, JOINT_PX) : 0;
          const lo = bandOf(partner)[1];
          // a slab partner's bottom becomes the joint, so the joint may not
          // sit above anything that slab already contains
          const pDesc = placed.filter((k) => k !== partner && isAncestor(partner!, k));
          const descFloor = pDesc.length ? Math.max(...pDesc.map((k) => k.B)) - J : -Infinity;
          // the lower event's own label block needs room too: lift the joint
          // toward the upper's band (at most one step above its real start)
          const roomTop = Math.max(n.endMin * pxPerMin - J - bandPx.get(n)!, natural - J);
          const a = Math.max(lo, Math.min(n.T + ov / 2 - J / 2, roomTop), descFloor);
          n.T = a;
          n.jt = J;
          // a C-shape steps at its spine: its left strip runs on to its end
          // and the event below tucks in under its nested events, edge to
          // edge, instead of meeting it halfway across
          n.jtx = partner.slab ? SLEEVE_LANE_PX : null;
          n.B = Math.max(n.endMin * pxPerMin, n.T + J + LABEL_PX, n.T + minHeight(n));
        }
      }
      for (const q of placed) {
        if (q === partner || isAncestor(q, n)) continue;
        // (c) I would cover an already-placed title band: start below it
        const [qa, qb] = bandOf(q);
        if (n.T < qb - 0.5 && n.B > qa + 0.5) n.T = Math.max(n.T, qb);
      }
      if (n.T <= before + 0.01 && guard > 0) break;
    }
    // finalize the joint against the settled top
    if (partner) {
      partner.B = n.T + n.jt;
      partner.jb = n.jt;
      partner.jbx = n.jtx;
    }
    n.B = Math.max(n.B, n.T + n.jt + (n.c ? minHeight(n) : n.slab ? bandPx.get(n)! : LABEL_PX));
    placed.push(n);
    // every enclosing event keeps this box inside it (no blank strip beside
    // an inset child); enclosers are slabs on the bottom layer, so growing
    // them never covers anything
    for (const a of ancestors) a.B = Math.max(a.B, n.B, lowBand.has(a) ? bandOf(a)[1] : 0);
  }

  const slabs = nodes.filter((n) => n.slab).map((n) => n.it!);
  const fgSorted = nodes.filter((n) => n.it && !n.slab).map((n) => n.it!);
  const containers: ContainerLayout<T>[] = slabs.map((e) => {
    const n = nodeOf.get(e)!;
    return {
      item: e.item,
      lane: n.depth,
      top: n.T,
      height: n.B - n.T,
      seamTopPx: n.jt,
      seamBottomPx: n.jb,
      seamTopStepPx: n.jtx,
      seamBottomStepPx: n.jbx,
      z: n.rank + 1,
    };
  });

  const regular: SleevePacked<T>["regular"] = fgSorted.map((e) => {
    const n = nodeOf.get(e)!;
    return {
      item: e.item,
      top: n.T,
      height: Math.max(n.B - n.T, 13),
      leftPct: 0,
      widthPct: 100,
      insetPx: n.depth * SLEEVE_LANE_PX,
      seamTopPx: n.jt,
      seamBottomPx: n.jb,
      seamTopStepPx: n.jtx,
      seamBottomStepPx: n.jbx,
      z: n.rank + 1,
    };
  });
  for (const n of nodes) {
    if (n.c) {
      n.c.top = n.T;
      n.c.height = n.B - n.T;
      n.c.z = n.rank + 1;
    }
  }

  {
    const DAY_PX = 1440 * pxPerMin;
    const boxes: { top: number; height: number }[] = [...containers, ...regular, ...clusters];
    boxes.sort((a, b) => a.top - b.top);
    const groups: { top: number; height: number }[][] = [];
    let cur: { top: number; height: number }[] = [];
    let curBot = -Infinity;
    for (const b of boxes) {
      if (cur.length && b.top >= curBot - 0.01) {
        groups.push(cur);
        cur = [];
        curBot = -Infinity;
      }
      cur.push(b);
      curBot = Math.max(curBot, b.top + b.height);
    }
    if (cur.length) groups.push(cur);
    let limit = DAY_PX;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      const top = Math.min(...g.map((b) => b.top));
      const bot = Math.max(...g.map((b) => b.top + b.height));
      const shift = Math.max(0, bot - limit);
      if (shift > 0) for (const b of g) b.top -= shift;
      limit = top - shift;
    }
  }

  return {
    containers,
    regular,
    clusters,
    laneCount: Math.max(0, ...[...depth.values()]) + 1,
  };
}

/** Clip path for a jointed chip, in the chip's own pixel space. Every corner
 *  (outer and the joint's notch) is rounded, so the joint reads as two
 *  softened blocks fitting together rather than a hard cut. Same-depth
 *  partners share width and inset, so their halves are exactly complementary
 *  (convex and concave fillets at a shared vertex trace the same curve). */
export function jointClipPath(
  w: number,
  h: number,
  seamTop: number,
  seamBottom: number,
  style: "rabbet" | "scarf",
  r = 4,
  stepTop: number | null = null,
  stepBottom: number | null = null,
): string {
  return `path("${jointPathD(w, h, seamTop, seamBottom, style, r, stepTop, stepBottom)}")`;
}

/** where a rabbet joint steps across a box w wide: at `step` px from the
 *  left (a C-shape's spine), else halfway; never so close to an edge that
 *  the corners can't round. Partners share width and inset, so both halves
 *  of a joint compute the same x. */
export function jointStepX(w: number, step: number | null | undefined, r = 4): number {
  const mid = Math.round(w / 2);
  if (step == null) return mid;
  return Math.max(Math.min(2 * r, mid), Math.min(step, mid));
}

/** The outline itself as SVG path data (same shape the clip path cuts):
 *  also what a goal ring traces, notch and all. */
export function jointPathD(
  w: number,
  h: number,
  seamTop: number,
  seamBottom: number,
  style: "rabbet" | "scarf",
  r = 4,
  stepTop: number | null = null,
  stepBottom: number | null = null,
): string {
  const topX = jointStepX(w, stepTop, r);
  const botX = jointStepX(w, stepBottom, r);
  const pts: [number, number][] = [];
  if (style === "rabbet") {
    if (seamTop > 0) pts.push([topX, 0]);
    else pts.push([0, 0]);
    pts.push([w, 0]);
    if (seamBottom > 0) {
      pts.push([w, h - seamBottom], [botX, h - seamBottom], [botX, h]);
    } else {
      pts.push([w, h]);
    }
    pts.push([0, h]);
    // A fractional-pixel seam can round above the preceding chip's bottom
    // after CSS path serialization. Cover that hairline on the lower chip.
    if (seamTop > 0) pts.push([0, Math.max(0, seamTop - 0.1)], [topX, Math.max(0, seamTop - 0.1)]);
  } else {
    pts.push([0, seamTop > 0 ? seamTop : 0], [w, 0]);
    pts.push([w, seamBottom > 0 ? h - seamBottom : h], [0, h]);
  }
  // drop duplicate consecutive points
  const clean = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    return Math.abs(p[0] - q[0]) > 0.01 || Math.abs(p[1] - q[1]) > 0.01;
  });
  const fmt = (p: number[]) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  const n = clean.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = clean[i];
    const a = clean[(i - 1 + n) % n];
    const b = clean[(i + 1) % n];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const rr = Math.min(r, da / 2, db / 2);
    const p1 = [p[0] + ((a[0] - p[0]) * rr) / da, p[1] + ((a[1] - p[1]) * rr) / da];
    const p2 = [p[0] + ((b[0] - p[0]) * rr) / db, p[1] + ((b[1] - p[1]) * rr) / db];
    d += `${i === 0 ? "M" : "L"}${fmt(p1)}Q${fmt(p)} ${fmt(p2)}`;
  }
  return `${d}Z`;
}
