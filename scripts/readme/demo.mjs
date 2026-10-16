// A made-up week for the README's screenshots and video: Rosa, a freelance
// writer who is working on her first novel, paints, reads novels and swims.
// Nothing here comes from a real calendar. Loaded into the browser mock
// through globalThis.__calFixture (src/lib/mockBackend.ts), with the
// reconciliation / star state seeded into localStorage.

export const DEMO_NOW = "2026-10-22T15:30:00"; // a Thursday afternoon
const WEEK0 = new Date(2026, 9, 18); // Sunday
const P = "rosa@example.com"; // the primary calendar

// legacy Google API colors: the app maps them to what Google shows. The
// focus score counts Homework, Learning and Research and Enrichment as deep
// work: here, the novel and workshop assignments, research, painting and
// reading.
export const calendars = [
  { id: P, summary: "Personal", color: "#4986e7", is_primary: true, hidden: false, access_role: "owner" },
  { id: "clients", summary: "Editors", color: "#cd74e6", is_primary: false, hidden: false, access_role: "owner" },
  { id: "work", summary: "Freelance", color: "#9a9cff", is_primary: false, hidden: false, access_role: "owner" },
  { id: "homework", summary: "Homework", color: "#fad165", is_primary: false, hidden: false, access_role: "owner" },
  { id: "research", summary: "Learning and Research", color: "#f83a22", is_primary: false, hidden: false, access_role: "owner" },
  { id: "enrichment", summary: "Enrichment", color: "#b3dc6c", is_primary: false, hidden: false, access_role: "owner" },
  { id: "fitness", summary: "Swimming", color: "#92e1c0", is_primary: false, hidden: false, access_role: "owner" },
  { id: "sleep", summary: "Sleep", color: "#16a765", is_primary: false, hidden: false, access_role: "owner" },
  { id: "distractions", summary: "Distractions", color: "#ac725e", is_primary: false, hidden: false, access_role: "owner" },
  { id: "holidays", summary: "US Holidays", color: "#9fe1e7", is_primary: false, hidden: false, access_role: "reader" },
];

export const goals = {
  goals: [
    { id: "d1", horizon: "daily", text: "Write 1,000 words of the novel" },
    { id: "d2", horizon: "daily", text: "Read 30 pages" },
    { id: "d3", horizon: "daily", text: "Swim or stretch" },
    { id: "w1", horizon: "weekly", text: "Finish chapter 8" },
    { id: "w2", horizon: "weekly", text: "Pitch two editors" },
    { id: "w3", horizon: "weekly", text: "Paint one canvas" },
    { id: "l1", horizon: "long", text: "Finish the novel manuscript" },
    { id: "l2", horizon: "long", text: "Become a New York Times bestseller" },
    { id: "l3", horizon: "long", text: "Win the Pulitzer Prize for Fiction" },
  ],
  // ticked today / this week (lib/goals.ts periods)
  checks: { d2: "2026-10-22", w2: "w2026-10-18" },
};

const at = (day, hm) => {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(WEEK0);
  d.setDate(d.getDate() + day);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

let n = 0;
/** day: 0 = Sunday … 6 = Saturday; an end before the start runs past midnight */
function ev(cal, summary, day, from, to, extra = {}) {
  const start = at(day, from);
  let end = at(day, to);
  if (end <= start) end = at(day + 1, to);
  return {
    id: `demo-${++n}`,
    calendar_id: cal,
    etag: null,
    summary,
    description: extra.note ? `[DRILL] ${extra.note}` : null,
    location: extra.location ?? null,
    start,
    end,
    all_day: false,
    timezone: null,
    status: "confirmed",
    recurrence: null,
    recurring_event_id: null,
    conference_url: extra.meet ?? null,
    updated: null,
    raw: { created: start },
  };
}

const E = [];
const add = (...a) => {
  const e = ev(...a);
  E.push(e);
  return e;
};

// nights
const bed = ["23:30", "23:40", "01:45", "00:20", "23:50", "00:40", "00:30"];
const sleepNotes = { 2: "1:45 AM, again. Your future self is paying for this.", 3: "12:20. Better. Hold it." };
for (let d = 0; d < 7; d++) add("sleep", "Sleep", d, bed[d], "07:00", sleepNotes[d] ? { note: sleepNotes[d] } : {});
for (let d = 0; d < 7; d++) add(P, "Lunch", d, "12:30", "13:00");

// Sunday
add("fitness", "Long swim", 0, "09:00", "10:00");
add(P, "Farmers market", 0, "11:00", "12:00");
add("enrichment", "Painting: harbor study", 0, "14:00", "16:30");
add("enrichment", "Read: Middlemarch", 0, "20:00", "21:30", { note: "Read it, then write one page about it." });

// Monday
add("fitness", "Swim laps", 1, "07:00", "07:45");
const ch7 = add("homework", "Novel: chapter 7", 1, "08:00", "10:15", { note: "Two hours, 600 words. Write worse, faster." });
// rabbet joint: the editor call runs into the interview
add("clients", "Editor call: Harbor Review", 1, "10:30", "11:50");
add("work", "Interview: bakery owner", 1, "11:30", "12:20", { location: "Rye & Salt" });
add("work", "Article draft: city bakeries", 1, "14:00", "16:30", { note: "Two and a half hours for 800 words. Decide, then polish." });
// a burst of overlapping little tasks: clustered into one readable list
["Email", "Send invoice", "Call landlord", "Book library room", "Reply to Mia"].forEach((t, i) =>
  add(P, t, 1, `17:${String(i * 5).padStart(2, "0")}`, `17:${String(i * 5 + 15).padStart(2, "0")}`),
);
add("distractions", "Distraction: YouTube", 1, "22:10", "23:30", { note: "80 minutes of videos. The novel won't write itself." });

// Tuesday
const workshop = add("homework", "Workshop homework: dialogue", 2, "07:30", "09:00", { note: "90 minutes, one scene. Now cut it in half." });
add("work", "Pitch editors", 2, "09:30", "10:30");
add("research", "Research: 1920s Lisbon", 2, "11:00", "12:00", { note: "Research is not writing. Stop at noon." });
add("work", "Client edits", 2, "13:00", "14:30");
add("research", "Research: archive photos", 2, "15:00", "17:30", { note: "Instagram in the middle of the archive? Really." });
add("distractions", "Distraction: Instagram", 2, "16:40", "17:20");
add(P, "Dinner with Mia", 2, "18:00", "19:00", { location: "Taqueria" });
add("enrichment", "Figure drawing class", 2, "19:30", "21:30", { note: "Two hours, one good sketch. Keep the bad ones too." });

// Wednesday (still to review)
add("homework", "Novel: chapter 7 revisions", 3, "08:30", "10:00", { note: "Polishing commas is not revising. Move on." });
add("clients", "Coffee with editor", 3, "10:15", "10:45");
add("work", "Interview: ferry captain", 3, "11:00", "11:45");
add("work", "Fact-check article", 3, "14:00", "15:00");
const skipped = add("fitness", "Swim laps", 3, "18:00", "19:00", { note: "Skipped the pool. Third time this month." });
add("distractions", "Distraction: Phone in bed", 3, "23:40", "00:30", { note: "Scrolling at midnight is a choice. Choose sleep." });

// Thursday: C-shape, a long block with short things inside it
const ch8 = add("homework", "Novel: chapter 8", 4, "09:00", "12:30", { note: "Three and a half hours, 1,100 words. Tighter." });
add("clients", "Call with agent", 4, "09:45", "10:00");
add(P, "Coffee", 4, "10:45", "11:05");
add("work", "Invoices and admin", 4, "13:00", "14:20");
add("distractions", "Distraction: Twitter", 4, "13:10", "13:40");
add("enrichment", "Watercolor class", 4, "16:00", "17:30");
add(P, "Book club", 4, "19:00", "20:30", { location: "Corner Books" });

// later this week (not yet happened)
add("fitness", "Swim laps", 5, "07:00", "07:45");
add("work", "Article draft: ferry story", 5, "09:30", "12:00");
add("clients", "Editor call", 5, "14:00", "15:00");
add(P, "Gallery opening", 5, "18:00", "20:00", { location: "Main St Gallery" });
add("fitness", "Open water swim", 6, "08:00", "09:30");
add("enrichment", "Painting: portrait", 6, "13:00", "15:30");
add(P, "Call Mom", 6, "18:00", "18:30");

export const events = E;

/** localStorage for the page: what was reviewed, what is goal work */
export function storage() {
  const recon = {};
  const done = (e) => (recon[`${e.calendar_id}/${e.id}`] = { s: "done", at: Date.now() });
  const nowMs = new Date(DEMO_NOW).getTime();
  for (const e of E) {
    const end = new Date(e.end).getTime();
    // everything up to Tuesday reviewed; Wednesday left for the sweep
    if (end < new Date(2026, 9, 21).getTime()) done(e);
    else if (end < nowMs && new Date(e.start) >= new Date(2026, 9, 22)) done(e);
  }
  // one plan that didn't happen, kept on the calendar for the record
  recon[`${skipped.calendar_id}/${skipped.id}`] = { s: "canceled", at: Date.now() };
  const stars = {
    [`${ch8.calendar_id}/${ch8.id}`]: { goal: "Finish the novel manuscript" },
    [`${ch7.calendar_id}/${ch7.id}`]: { goal: "Finish the novel manuscript" },
    [`${workshop.calendar_id}/${workshop.id}`]: { goal: "Win the Pulitzer Prize for Fiction" },
  };
  return {
    recon: JSON.stringify(recon),
    "recon-since": String(new Date(2026, 8, 1).getTime()),
    "goal-stars": JSON.stringify(stars),
  };
}
