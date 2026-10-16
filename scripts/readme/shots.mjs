// README media: screenshots of the demo week (scripts/readme/demo.mjs) in
// the browser mock. Needs the dev server (`npm run dev`, :1420).
//   PLAYWRIGHT_BROWSERS_PATH=0 node scripts/readme/shots.mjs
// Writes docs/media/*.png (and docs/media/frames/* for the video). Light
// theme (the README's choice); MEDIA_SCHEME=dark for the dark one.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { openDemo } from "./page.mjs";
import { calendars, events } from "./demo.mjs";

const OUT = resolve("docs/media");
const scheme = process.env.MEDIA_SCHEME === "dark" ? "dark" : "light";
// the composites' own page, in the app's colors for that theme; Google's
// column in Google Calendar's
const T =
  scheme === "dark"
    ? { bg: "#191919", fg: "#e8e8e6", sub: "#9b9a97", cap: "#c9c8c5", edge: "rgba(255,255,255,.08)", gbg: "#202124", gline: "#3c4043" }
    : { bg: "#ffffff", fg: "#1f1f1f", sub: "#6f6e69", cap: "#37352f", edge: "rgba(0,0,0,.1)", gbg: "#ffffff", gline: "#dadce0" };
mkdirSync(`${OUT}/parts`, { recursive: true });
mkdirSync(`${OUT}/frames`, { recursive: true });
const b = await chromium.launch();

/** page coordinates of a chip, for crops */
const box = async (page, sel) => (await page.locator(sel).first().boundingBox());
const scrollTo = (page, hour) =>
  page.getByTestId("week-grid").evaluate((el, h) => (el.scrollTop = h * (el.scrollHeight / 24)), hour);
const settle = (page) => page.waitForTimeout(700);
/** hold every goal light at the same point of its run (ms into it), so a
 *  still shows it on the box's top edge */
const freezeShine = (page, L = 320) =>
  page.evaluate((L) => {
    for (const a of document.getAnimations()) {
      if (!(a.effect?.target instanceof Element) || !a.effect.target.classList.contains("goal-run")) continue;
      const d = a.effect.getTiming().delay;
      a.pause();
      a.currentTime = (((L + d) % 10000) + 10000) % 10000;
    }
  }, L);

// ---- the whole week (video frame + annotations) ----
{
  const page = await openDemo(b, { width: 1440, height: 900, scheme });
  await page.getByTestId("sweep-banner").locator(".toast-close").click();
  await scrollTo(page, 7.6);
  await settle(page);
  await freezeShine(page);
  await page.screenshot({ path: `${OUT}/frames/week.png` });
  // annotations: the week without the sidebar, notes everywhere
  await page.keyboard.press("`");
  await scrollTo(page, 7.6);
  await settle(page);
  await page.locator("[data-testid=margin-notes][data-pending='0']").waitFor();
  await page.screenshot({ path: `${OUT}/annotations.png` });
  await page.context().close();
}

// ---- reconcile: one scene, close up: yesterday in day view, its events
// still dotted (unconfirmed), ✓ / ✕ on the hovered one, the reminder ----
{
  const page = await openDemo(b, { width: 1000, height: 625, scheme });
  await page.keyboard.press("`"); // no sidebar
  await page.keyboard.press("d"); // day view
  await page.keyboard.press("k"); // back to yesterday
  await page.keyboard.press("Meta+Shift+."); // zoom in
  await settle(page);
  await scrollTo(page, 7.75);
  await settle(page);
  await page.locator(".chip-timed", { hasText: "Fact-check article" }).hover();
  await page.waitForTimeout(250);
  const grid = await box(page, "[data-testid=week-grid]");
  await page.screenshot({ path: `${OUT}/reconcile.png`, clip: { x: grid.x, y: grid.y, width: grid.width, height: grid.height } });
  await page.screenshot({ path: `${OUT}/frames/reconcile.png` });
  await page.context().close();
}

// ---- focus score / highlighted events / goals: three parts ----
{
  const page = await openDemo(b, { width: 1440, height: 900, scheme });
  await page.getByTestId("sweep-banner").locator(".toast-close").click();
  await scrollTo(page, 8.4);
  await settle(page);
  await freezeShine(page);
  // the goal dashboard: the sidebar's goals
  const goals = await box(page, "[data-testid=goals-section]");
  await page.screenshot({ path: `${OUT}/parts/goals.png`, clip: { x: goals.x, y: goals.y - 4, width: goals.width, height: goals.height + 8 } });
  // highlighted goal work: the starred research block, light mid-run
  const run = await box(page, ".chip-timed:has-text('Novel: chapter 8')");
  const col = await box(page, "[data-testid=day-col-4]");
  await page.screenshot({ path: `${OUT}/parts/highlight.png`, clip: { x: col.x - 6, y: run.y - 30, width: col.width + 12, height: run.height + 60 } });
  // the focus score's explanation: hover Tuesday's badge
  const badge = page.locator("[data-testid=day-score]").nth(2);
  await badge.hover();
  await page.locator(".score-pop").waitFor();
  await page.waitForTimeout(200);
  const pop = await box(page, ".score-pop");
  const bb = await badge.boundingBox();
  const x0 = Math.min(pop.x, bb.x) - 10;
  const y0 = Math.min(pop.y, bb.y) - 10;
  await page.screenshot({
    path: `${OUT}/parts/focus.png`,
    clip: { x: x0, y: y0, width: Math.max(pop.x + pop.width, bb.x + bb.width) - x0 + 10, height: pop.y + pop.height - y0 + 10 },
  });
  await page.screenshot({ path: `${OUT}/frames/focus.png` });
  await page.context().close();
}

// ---- overlaps: C-shape, rabbet joint, cluster: this app vs Google's layout ----
// the same 4-hour windows of the same events, drawn both ways
const WINDOWS = [
  { name: "cshape", caption: "C-shape invariance", day: 4, from: 8.75, to: 12.75 },
  { name: "rabbet", caption: "rabbet joint", day: 1, from: 10, to: 14 },
  { name: "cluster", caption: "clustered view", day: 1, from: 16.5, to: 20.5 },
];
{
  const page = await openDemo(b, { width: 1440, height: 1100, scheme });
  await page.getByTestId("sweep-banner").locator(".toast-close").click();
  await page.keyboard.press("`");
  await settle(page);
  for (const w of WINDOWS) {
    await scrollTo(page, w.from - 0.5);
    await settle(page);
    const col = await box(page, `[data-testid=day-col-${w.day}]`);
    // the grid's own hour lines say where an hour is on screen
    const { top, hourPx } = await page.getByTestId("week-grid").evaluate((el, h) => {
      const lines = [...el.querySelectorAll(".hline")].map((l) => l.getBoundingClientRect().top);
      const px = lines[1] - lines[0];
      return { top: lines[Math.floor(h)] + (h - Math.floor(h)) * px, hourPx: px };
    }, w.from);
    await page.screenshot({
      path: `${OUT}/parts/${w.name}.png`,
      clip: { x: col.x - 1, y: top, width: col.width + 2, height: (w.to - w.from) * hourPx },
    });
    w.width = col.width + 2;
    w.hourPx = hourPx;
  }
  await page.context().close();
}

// Google Calendar's way, for comparison: the classic column split (each
// overlapping run divided into equal side-by-side columns), solid fills,
// white text cut with an ellipsis
const GCAL = { "#4986e7": "#3f51b5", "#fad165": "#f6bf26", "#f83a22": "#d50000", "#b3dc6c": "#c0ca33", "#92e1c0": "#33b679", "#16a765": "#0b8043", "#ac725e": "#795548", "#cd74e6": "#8e24aa", "#9a9cff": "#7986cb", "#9fe1e7": "#039be5" };
const colorOf = (id) => GCAL[calendars.find((c) => c.id === id).color];
function gcalColumn(w) {
  const day0 = new Date(2026, 9, 18 + w.day);
  const hrs = (iso) => (new Date(iso) - day0) / 3600000;
  const evs = events
    .map((e) => ({ e, s: hrs(e.start), t: hrs(e.end) }))
    .filter((x) => x.t > w.from && x.s < w.to)
    .sort((a, b) => a.s - b.s || b.t - a.t);
  // cluster overlapping runs, leftmost free column, width = 1 / columns
  const out = [];
  let run = [];
  let runEnd = -1;
  const flush = () => {
    const cols = [];
    for (const x of run) {
      let c = cols.findIndex((end) => end <= x.s);
      if (c < 0) c = cols.push(0) - 1;
      cols[c] = x.t;
      x.col = c;
    }
    for (const x of run) out.push({ ...x, n: cols.length });
    run = [];
  };
  for (const x of evs) {
    if (run.length && x.s >= runEnd) flush();
    run.push(x);
    runEnd = Math.max(runEnd, x.t);
  }
  flush();
  const fmt = (h) => {
    const H = Math.floor(h + 1e-9);
    const M = Math.round((h - H) * 60);
    return `${H % 12 || 12}${M ? ":" + String(M).padStart(2, "0") : ""}${H < 12 ? "am" : "pm"}`;
  };
  const H = (w.to - w.from) * w.hourPx;
  return `<div class="gcol" style="width:${w.width}px;height:${H}px">${[...Array(Math.ceil(w.to - w.from) + 1).keys()]
    .map((i) => `<div class="hl" style="top:${(Math.ceil(w.from) - w.from + i) * w.hourPx}px"></div>`)
    .join("")}${out
    .map((x) => {
      const top = (Math.max(x.s, w.from) - w.from) * w.hourPx;
      const h = Math.max(14, (Math.min(x.t, w.to) - Math.max(x.s, w.from)) * w.hourPx - 1);
      const wd = (w.width - 10) / x.n;
      return `<div class="gev" style="top:${top}px;height:${h}px;left:${2 + x.col * wd}px;width:${wd - 2}px;background:${colorOf(x.e.calendar_id)}"><b>${x.e.summary}</b>${h > 26 ? `<br>${fmt(x.s)} – ${fmt(x.t)}` : `, ${fmt(x.s)}`}</div>`;
    })
    .join("")}</div>`;
}

const dataUri = (path) => "data:image/png;base64," + readFileSync(path).toString("base64");
async function composite(path, title, cells, width) {
  const page = await (await b.newContext({ viewport: { width, height: 400 }, deviceScaleFactor: 2 })).newPage();
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;background:${T.bg};font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:${T.fg}}
    .wrap{display:inline-flex;flex-direction:column;gap:14px;padding:22px 26px 20px}
    h3{margin:0;font-size:13px;font-weight:600;color:${T.sub};letter-spacing:.02em}
    .row{display:flex;gap:26px;align-items:flex-start}
    .cell{display:flex;flex-direction:column;align-items:center;gap:10px}
    .cell img{display:block;border-radius:6px;border:1px solid ${T.edge}}
    .cap{font-size:13px;color:${T.fg}}
    .gcol{position:relative;background:${T.gbg};border-radius:6px;border:1px solid ${T.edge};overflow:hidden}
    .hl{position:absolute;left:0;right:0;border-top:1px solid ${T.gline}}
    .gev{position:absolute;box-sizing:border-box;border:1px solid ${T.gbg};border-radius:4px;padding:2px 5px;color:#fff;font:12px/15px Roboto,"Google Sans",Arial,sans-serif;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .gev b{font-weight:500}
  </style></head><body><div class="wrap" id="w">${title ? `<h3>${title}</h3>` : ""}<div class="row">${cells
    .map((c) => `<div class="cell">${c.html}<div class="cap">${c.caption}</div></div>`)
    .join("")}</div></div></body></html>`);
  await page.waitForTimeout(300);
  await page.locator("#w").screenshot({ path });
  await page.context().close();
}

await composite(
  `${OUT}/overlaps.png`,
  "",
  WINDOWS.map((w) => ({ caption: w.caption, html: `<img src="${dataUri(`${OUT}/parts/${w.name}.png`)}" width="${w.width}">` })),
  900,
);
await composite(
  `${OUT}/overlaps-gcal.png`,
  "The same events, laid out the way Google Calendar does",
  WINDOWS.map((w) => ({ caption: w.caption, html: gcalColumn(w) })),
  900,
);
{
  const part = (n) => `${OUT}/parts/${n}.png`;
  const size = (n) => {
    const buf = readFileSync(part(n));
    return { w: buf.readUInt32BE(16) / 2, h: buf.readUInt32BE(20) / 2 };
  };
  const cell = (n, caption, maxW) => {
    const { w, h } = size(n);
    const k = Math.min(1, maxW / w, 420 / h);
    return { caption, html: `<img src="${dataUri(part(n))}" width="${Math.round(w * k)}">` };
  };
  await composite(
    `${OUT}/focus-goals.png`,
    "",
    [cell("focus", "1. Focus score", 300), cell("highlight", "2. Highlighted goal work", 200), cell("goals", "3. Goal dashboard", 260)],
    1100,
  );
}

// ---- for the video: this app and Google's layout, side by side, one 16:10
// frame (1920x1200) with room below for the caption ----
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  const colW = 184;
  const group = (label, cls, cells) =>
    `<div class="grp"><div class="lab ${cls}">${label}</div><div class="cols">${cells
      .map((c) => `<div class="cell">${c.html}<div class="cap">${c.caption}</div></div>`)
      .join("")}</div></div>`;
  const ours = WINDOWS.map((w) => ({
    caption: w.caption,
    html: `<img src="${dataUri(`${OUT}/parts/${w.name}.png`)}" style="width:${colW}px">`,
  }));
  const theirs = WINDOWS.map((w) => ({
    caption: w.caption,
    html: `<div style="zoom:${colW / w.width}">${gcalColumn(w)}</div>`,
  }));
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;width:1280px;height:800px;background:${T.bg};font:13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:${T.fg};overflow:hidden}
    .row{display:flex;justify-content:center;gap:30px;padding-top:150px}
    .grp{display:flex;flex-direction:column;gap:12px}
    .lab{font-size:17px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
    .lab.ns{color:#c99512}.lab.g{color:${T.sub}}
    .cols{display:flex;gap:8px}
    .cell{display:flex;flex-direction:column;align-items:center;gap:8px}
    .cell img{display:block;border-radius:6px;border:1px solid ${T.edge}}
    .cap{font-size:13px;color:${T.cap}}
    .gcol{position:relative;background:${T.gbg};border-radius:6px;border:1px solid ${T.edge};overflow:hidden}
    .hl{position:absolute;left:0;right:0;border-top:1px solid ${T.gline}}
    .gev{position:absolute;box-sizing:border-box;border:1px solid ${T.gbg};border-radius:4px;padding:2px 5px;color:#fff;font:12px/15px Roboto,"Google Sans",Arial,sans-serif;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .gev b{font-weight:500}
  </style></head><body><div class="row">${group("northstar", "ns", ours)}${group("Google Calendar", "g", theirs)}</div></body></html>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/frames/compare.png` });
  await ctx.close();
}

await b.close();
writeFileSync(`${OUT}/.shots-done`, new Date().toISOString());
console.log("shots in", OUT);
