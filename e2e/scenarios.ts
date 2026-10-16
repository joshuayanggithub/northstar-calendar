// Dummy-calendar generator for overlap-layout testing: hand-built scenario
// families (one per day of the mock week Oct 11-17 2026) plus seeded random
// weeks. Times are local wall-clock.

export interface ScEvent {
  title: string;
  start: Date;
  end: Date;
  cal: string;
  location?: string;
  drill?: string;
}

const CALS = ["c-blue", "c-green", "c-brown", "c-gray", "c-red"];

function at(day: number, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  // day 0 = Sunday Oct 11 2026
  return new Date(2026, 9, 11 + day, h, m, 0, 0);
}

type Row = [string, string, string]; // start, end, title

function dayRows(day: number, rows: Row[]): ScEvent[] {
  return rows.map(([s, e, title], i) => ({
    title,
    start: at(day, s),
    end: e === "24:00" ? at(day + 1, "00:00") : at(day, e),
    cal: CALS[(i + day) % CALS.length],
  }));
}

const LONG = "with a deliberately long title that has to wrap across several lines";

/** Sunday: C-shape (enclosure) variants. */
const containment: Row[] = [
  ["01:00", "03:00", "Container, child flush at start"],
  ["01:00", "01:30", "flush child"],
  ["03:30", "06:00", "Container, child flush at end"],
  ["05:30", "06:00", "end-flush child"],
  ["06:30", "09:30", "Depth 0"],
  ["06:30", "09:00", "Depth 1"],
  ["06:30", "08:00", "Depth 2"],
  ["07:00", "07:30", "Depth 3"],
  ["10:00", "13:00", "Study block"],
  ["10:10", "10:40", "near-flush child"],
  ["10:50", "11:40", "second child"],
  ["11:45", "12:00", "third child"],
  ["14:00", "16:00", "Back-to-back host"],
  ["14:00", "14:20", "kid 1"],
  ["14:20", "14:40", "kid 2"],
  ["14:40", "15:00", "kid 3"],
  ["15:00", "15:20", "kid 4"],
  ["17:00", "17:45", "Short container"],
  ["17:00", "17:15", "tiny kid"],
  ["19:00", "21:00", `Container ${LONG}`],
  ["19:15", "19:45", `Child ${LONG}`],
  ["22:00", "24:00", "Late container"],
  ["23:30", "24:00", "midnight kid"],
];

/** Monday: partial overlaps (joints) at many overlap sizes, plus a chain. */
const joints: Row[] = [
  ["00:30", "01:30", "J 1-minute overlap A"],
  ["01:29", "02:29", "J 1-minute overlap B"],
  ["03:00", "04:00", "J 5-minute A"],
  ["03:55", "04:55", "J 5-minute B"],
  ["06:00", "07:00", "J 15-minute A"],
  ["06:45", "07:45", "J 15-minute B"],
  ["08:30", "09:30", "J half-hour A"],
  ["09:00", "10:00", "J half-hour B"],
  ["11:00", "12:00", "J 45-minute A"],
  ["11:15", "12:15", "J 45-minute B"],
  ["13:00", "13:30", "J short A"],
  ["13:15", "13:45", "J short B"],
  ["14:30", "14:45", "J tiny A"],
  ["14:35", "14:50", "J tiny B"],
  ["16:00", "17:30", "J long A"],
  ["16:30", "18:30", "J long B"],
  ["19:00", "19:40", `Chain 1 ${LONG}`],
  ["19:30", "20:10", `Chain 2 ${LONG}`],
  ["20:00", "20:40", "Chain 3"],
  ["20:30", "21:10", "Chain 4"],
  ["21:00", "21:40", "Chain 5"],
  ["22:30", "23:30", "Late joint A"],
  ["23:15", "24:00", "Late joint B"],
];

/** Tuesday: joints and C-shapes combined. */
const mixed: Row[] = [
  ["00:40", "01:20", "Chip running into slab"],
  ["01:00", "04:00", "Slab after chip"],
  ["02:00", "02:30", "slab kid"],
  ["05:00", "07:00", "Slab A"],
  ["05:30", "06:00", "A kid"],
  ["06:30", "08:30", "Slab B (partial over A)"],
  ["07:00", "07:30", "B kid"],
  ["09:00", "11:00", "Slab C"],
  ["09:10", "09:40", "C kid"],
  ["10:45", "11:30", "Chip after slab C"],
  ["12:00", "15:00", "Parent with jointed kids"],
  ["12:30", "13:30", "jointed kid 1"],
  ["13:15", "14:00", "jointed kid 2"],
  ["15:30", "16:30", "Twin A"],
  ["15:30", "16:30", "Twin B"],
  ["17:00", "18:00", "Triplet A"],
  ["17:00", "18:00", "Triplet B"],
  ["17:00", "18:00", "Triplet C"],
  ["19:00", "21:00", "Outer"],
  ["19:30", "20:00", "inner"],
  ["20:30", "22:00", "Partial sibling of Outer"],
];

/** Wednesday: tiny / min-height events and cluster interactions. */
const tiny: Row[] = [
  ["00:00", "00:05", "t1"],
  ["00:05", "00:10", "t2"],
  ["00:10", "00:15", "t3"],
  ["01:00", "01:09", "In bed – falling asleep"],
  ["01:09", "08:00", "Asleep (6.8h)"],
  ["08:00", "08:06", "In bed – after waking"],
  ["09:00", "11:00", "Container with 5-minute kids"],
  ["09:00", "09:05", "5-min kid"],
  ["09:05", "09:10", "5-min kid 2"],
  ["12:00", "12:10", "Tiny partial A"],
  ["12:05", "12:15", "Tiny partial B"],
  ["13:00", "14:00", "Hour"],
  ["13:58", "14:30", "Two-minute overlap"],
  ["15:00", "15:25", "cluster a"],
  ["15:20", "15:45", "cluster b"],
  ["15:40", "16:05", "cluster c"],
  ["16:00", "16:20", "cluster d"],
  ["18:00", "21:00", "Cluster host"],
  ["18:30", "18:50", "hosted a"],
  ["18:45", "19:05", "hosted b"],
  ["19:00", "19:20", "hosted c"],
  ["22:00", "22:20", "short chain 1"],
  ["22:15", "22:40", "short chain 2"],
  ["22:35", "23:00", "short chain 3"],
];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["Read", "paper", "review", "lecture", "notes", "call", "gym", "lunch",
  "distraction", "email", "project", "sync", "study", "walk", "shower", "planning",
  "interview", "prep", "seminar", "writing", "code", "debug", "errand", "TikTok"];

/** A random day: clustered around a few busy hours so overlaps are common. */
function randomDay(day: number, rand: () => number): ScEvent[] {
  const out: ScEvent[] = [];
  const durations = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180];
  const n = 8 + Math.floor(rand() * 9);
  const PLACES = ["Gates 104", "Green Library, 2nd floor reading room", "Zoom"];
  const DRILLS = ["Again? You said this last week.", "Ship it or kill it. No more polishing, soldier."];
  const hubs = [8, 12, 15, 19, 22].map((h) => h * 60);
  for (let i = 0; i < n; i++) {
    const hub = hubs[Math.floor(rand() * hubs.length)];
    const startMin = Math.max(0, Math.min(1430, hub + Math.round((rand() * 150 - 75) / 5) * 5));
    const dur = durations[Math.floor(rand() * durations.length)];
    const endMin = Math.min(1440, startMin + dur);
    const words = 1 + Math.floor(rand() * (rand() < 0.2 ? 12 : 4));
    const title = Array.from({ length: words }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
    const s = new Date(2026, 9, 11 + day, 0, startMin);
    const e = new Date(2026, 9, 11 + day, 0, endMin);
    const ev: ScEvent = { title: `${title} #${i}`, start: s, end: e, cal: CALS[Math.floor(rand() * CALS.length)] };
    if (rand() < 0.2) ev.location = PLACES[Math.floor(rand() * PLACES.length)];
    if (rand() < 0.15) ev.drill = DRILLS[Math.floor(rand() * DRILLS.length)];
    out.push(ev);
  }
  return out;
}

/** label anatomy extras on hand-built rows: location and drill notes */
const EXTRAS: Record<string, Partial<ScEvent>> = {
  "Study block": { drill: "Three hours and one paper. Read faster." },
  "second child": { location: "Gates 104" },
  "Depth 1": { drill: "Nested meetings are a smell." },
  "J 45-minute A": { location: "Green Library, 2nd floor reading room" },
  "J long B": { drill: "Two hours of this? Justify it.", location: "Zoom" },
  "Parent with jointed kids": { location: "Huang basement", drill: "Where is the output?" },
  "Outer": { drill: "Stay on task." },
};

/** The canonical week: four scenario families + three seeded random days. */
export function canonicalWeek(seed = 7): ScEvent[] {
  const rand = rng(seed);
  return [
    ...dayRows(0, containment),
    ...dayRows(1, joints),
    ...dayRows(2, mixed),
    ...dayRows(3, tiny),
    ...randomDay(4, rand),
    ...randomDay(5, rand),
    ...randomDay(6, rand),
  ].map((e) => ({ ...e, ...(EXTRAS[e.title] ?? {}) }));
}

/** A fully random week for fuzzing. */
export function randomWeek(seed: number): ScEvent[] {
  const rand = rng(seed);
  return Array.from({ length: 7 }, (_, d) => randomDay(d, rand)).flat();
}
