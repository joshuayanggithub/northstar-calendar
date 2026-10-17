// README media: screenshots of the demo week (scripts/readme/demo.mjs) in
// the browser mock. Needs the dev server (`npm run dev`, :1420).
//   PLAYWRIGHT_BROWSERS_PATH=0 node scripts/readme/shots.mjs
// Writes docs/media/*.png. Light theme (the README's choice);
// MEDIA_SCHEME=dark for the dark one.
//
// One system for every image, so the README reads as one piece:
//  - every full-width image is the app in the same 1000x625 window, shown in
//    the README at the same width (800px), so the app's text is the same
//    size in each;
//  - the overlap comparisons are cells of one day column, in a tight frame,
//    shown at 350px so they come out at that same scale;
//  - every image gets the same frame: padding, rounded corners, a hairline
//    border and a soft shadow on a transparent canvas, baked into the PNG
//    (GitHub drops CSS). The shadow fades out inside the padding, so no
//    edge of the image shows on the page. scripts/readme/gif.mjs frames the
//    walkthrough GIF the same way.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDemo } from "./page.mjs";
import { calendars, events } from "./demo.mjs";

const OUT = resolve("docs/media");
const RAW = resolve("docs/media/.raw"); // unframed captures (untracked)
const scheme = process.env.MEDIA_SCHEME === "dark" ? "dark" : "light";
const T =
  scheme === "dark"
    ? { edge: "rgba(255,255,255,.12)", gbg: "#202124", gline: "#3c4043" }
    : { edge: "rgba(0,0,0,.1)", gbg: "#ffffff", gline: "#dadce0" };
/** the app window every full-width image shows */
const WIN = { width: 1000, height: 625 };
/** a cell's day column: 2-day view in this window gives the column width
 *  that lands a framed cell, at 380px in the README table, at the same
 *  scale as a full-width image at 800px */
const CELL_WIN = { width: 940, height: 900 };
const PAD = 28;
mkdirSync(RAW, { recursive: true });
const b = await chromium.launch();

const box = async (page, sel) => page.locator(sel).first().boundingBox();
const scrollTo = (page, hour) =>
  page.getByTestId("week-grid").evaluate((el, h) => (el.scrollTop = h * (el.scrollHeight / 24)), hour);
const settle = (page) => page.waitForTimeout(700);
const dataUri = (path) => "data:image/png;base64," + readFileSync(path).toString("base64");
const sizeOf = (path) => {
  const buf = readFileSync(path);
  return { w: buf.readUInt32BE(16) / 2, h: buf.readUInt32BE(20) / 2 };
};
/** hold every goal light at the same point of its run, so a still shows it */
const freezeShine = (page, L = 320) =>
  page.evaluate((L) => {
    for (const a of document.getAnimations()) {
      if (!(a.effect?.target instanceof Element) || !a.effect.target.classList.contains("goal-run")) continue;
      const d = a.effect.getTiming().delay;
      a.pause();
      a.currentTime = (((L + d) % 10000) + 10000) % 10000;
    }
  }, L);

/** the frame every image gets; the comparison cells sit in a grid, so
 *  theirs is tight (less padding, a shorter shadow that fades inside it) */
const TIGHT = { pad: 8, shadow: "0 2px 5px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.06)" };
async function frame(html, w, h, out, { pad = PAD, shadow = "0 6px 16px rgba(0,0,0,.12),0 1px 3px rgba(0,0,0,.08)" } = {}) {
  const ctx = await b.newContext({ viewport: { width: w + 2 * pad, height: h + 2 * pad }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;background:transparent}
    #f{display:inline-block;padding:${pad}px}
    .in{width:${w}px;height:${h}px;box-sizing:border-box;border-radius:10px;border:1px solid ${T.edge};overflow:hidden;
      box-shadow:${shadow}}
    .in > img{display:block;width:100%;height:100%}
    .gcol{position:relative;width:100%;height:100%;background:${T.gbg}}
    .hl{position:absolute;left:0;right:0;border-top:1px solid ${T.gline}}
    .gev{position:absolute;box-sizing:border-box;border:1px solid ${T.gbg};border-radius:4px;padding:2px 5px;color:#fff;
      font:12px/15px Roboto,"Google Sans",Arial,sans-serif;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .gev b{font-weight:500}
  </style></head><body><div id="f"><div class="in">${html}</div></div></body></html>`);
  await page.waitForTimeout(200);
  await page.locator("#f").screenshot({ path: out, omitBackground: true });
  await ctx.close();
}
const frameShot = async (raw, out, opts) => {
  const { w, h } = sizeOf(raw);
  await frame(`<img src="${dataUri(raw)}">`, w, h, out, opts);
};

// ---- reconcile: yesterday through tomorrow; yesterday's events still
// dotted (unconfirmed), ✓ / ✕ on the hovered one, the reminder below ----
{
  const page = await openDemo(b, { ...WIN, scheme });
  await page.keyboard.press("`"); // no sidebar
  await page.keyboard.press("d"); // day view, today
  await page.keyboard.press("k"); // yesterday
  await page.keyboard.press("3"); // three days from there
  await settle(page);
  await scrollTo(page, 7.75);
  await settle(page);
  await page.locator(".chip-timed", { hasText: "Fact-check article" }).hover();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${RAW}/reconcile.png` });
  await page.context().close();
  await frameShot(`${RAW}/reconcile.png`, `${OUT}/reconcile.png`);
}

// ---- annotations: the week, notes in its margins ----
{
  const page = await openDemo(b, { ...WIN, scheme });
  await page.getByTestId("sweep-banner").locator(".toast-close").click();
  await page.keyboard.press("`");
  // early enough that the notes written above the morning's events are whole
  await scrollTo(page, 7.25);
  await settle(page);
  await page.locator("[data-testid=margin-notes][data-pending='0']").waitFor();
  await freezeShine(page);
  await page.screenshot({ path: `${RAW}/annotations.png` });
  await page.context().close();
  await frameShot(`${RAW}/annotations.png`, `${OUT}/annotations.png`);
}

// ---- focus score, highlighted goal work, the goal dashboard: one window,
// the sidebar's goals, Tuesday to Thursday (wide enough to read with the
// sidebar open), Tuesday's score explained, Thursday's goal work lit ----
{
  const page = await openDemo(b, { ...WIN, scheme });
  await page.getByTestId("sweep-banner").locator(".toast-close").click();
  await page.keyboard.press("d");
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await page.keyboard.press("3");
  await settle(page);
  await scrollTo(page, 8.4);
  // the sidebar scrolled down to its goals
  await page.evaluate(() => {
    const sb = document.querySelector(".sidebar");
    const g = document.querySelector("[data-testid=goals-section]");
    sb.scrollTop = g.offsetTop - sb.offsetTop - 12;
  });
  await settle(page);
  await freezeShine(page);
  // Tuesday's score: its explanation opens over Tuesday, leaving Thursday's
  // highlighted goal work in view
  const badge = page.locator("[data-testid=day-score]").nth(0);
  await badge.hover();
  await page.locator(".score-pop").waitFor();
  await page.waitForTimeout(200);
  await freezeShine(page);
  await page.screenshot({ path: `${RAW}/focus-goals.png` });
  await page.context().close();
  await frameShot(`${RAW}/focus-goals.png`, `${OUT}/focus-goals.png`);
}

// ---- overlaps: C-shape, rabbet joint, cluster, this app vs Google's layout:
// the same 4-hour window of the same day, drawn both ways ----
// every window the same length, starting and ending in a gap, so no event
// is cut and the six cells match
const WINDOWS = [
  { name: "cshape", day: 4, from: 8.75, to: 12.5 },
  { name: "rabbet", day: 1, from: 10.25, to: 14 },
  { name: "cluster", day: 1, from: 16.75, to: 20.5 },
];
{
  const page = await openDemo(b, { ...CELL_WIN, scheme });
  await page.getByTestId("sweep-banner").locator(".toast-close").click();
  await page.keyboard.press("`");
  for (const w of WINDOWS) {
    // today (Thursday, day 4) in day view, back to the window's day one day
    // at a time, then two days from there: its column is the first
    await page.keyboard.press("t");
    await page.keyboard.press("d");
    for (let i = 0; i < 4 - w.day; i++) await page.keyboard.press("k");
    await page.keyboard.press("2");
    await settle(page);
    await scrollTo(page, w.from - 0.5);
    await settle(page);
    const col = await box(page, "[data-testid=day-col-0]");
    const { top, hourPx } = await page.getByTestId("week-grid").evaluate((el, h) => {
      const lines = [...el.querySelectorAll(".hline")].map((l) => l.getBoundingClientRect().top);
      const px = lines[1] - lines[0];
      return { top: lines[Math.floor(h)] + (h - Math.floor(h)) * px, hourPx: px };
    }, w.from);
    await page.screenshot({
      path: `${RAW}/${w.name}.png`,
      clip: { x: col.x, y: top, width: col.width, height: (w.to - w.from) * hourPx },
    });
    w.width = col.width;
    w.hourPx = hourPx;
  }
  await page.context().close();
}

// Google Calendar's way: the classic column split (each overlapping run
// divided into equal side-by-side columns), solid fills, white text cut with
// an ellipsis
const GCAL = { "#4986e7": "#3f51b5", "#fad165": "#f6bf26", "#f83a22": "#d50000", "#b3dc6c": "#c0ca33", "#92e1c0": "#33b679", "#16a765": "#0b8043", "#ac725e": "#795548", "#cd74e6": "#8e24aa", "#9a9cff": "#7986cb", "#9fe1e7": "#039be5" };
const colorOf = (id) => GCAL[calendars.find((c) => c.id === id).color];
function gcalColumn(w) {
  const day0 = new Date(2026, 9, 18 + w.day);
  const hrs = (iso) => (new Date(iso) - day0) / 3600000;
  const evs = events
    .map((e) => ({ e, s: hrs(e.start), t: hrs(e.end) }))
    .filter((x) => x.t > w.from && x.s < w.to)
    .sort((a, b) => a.s - b.s || b.t - a.t);
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
  return `<div class="gcol">${[...Array(Math.ceil(w.to - w.from) + 1).keys()]
    .map((i) => `<div class="hl" style="top:${(Math.ceil(w.from) - w.from + i) * w.hourPx}px"></div>`)
    .join("")}${out
    .map((x) => {
      const top = (Math.max(x.s, w.from) - w.from) * w.hourPx;
      const h = Math.max(14, (Math.min(x.t, w.to) - Math.max(x.s, w.from)) * w.hourPx - 1);
      const wd = (w.width - 10) / x.n;
      // a short event gets Google's small one-line text
      const small = h < 18 ? `;font-size:10.5px;line-height:${Math.max(9, h - 3)}px;padding-top:1px` : "";
      return `<div class="gev" style="top:${top}px;height:${h}px;left:${2 + x.col * wd}px;width:${wd - 2}px;background:${colorOf(x.e.calendar_id)}${small}"><b>${x.e.summary}</b>${h > 26 ? `<br>${fmt(x.s)} – ${fmt(x.t)}` : `, ${fmt(x.s)}`}</div>`;
    })
    .join("")}</div>`;
}
for (const w of WINDOWS) {
  const h = (w.to - w.from) * w.hourPx;
  await frameShot(`${RAW}/${w.name}.png`, `${OUT}/overlap-${w.name}.png`, TIGHT);
  await frame(gcalColumn(w), w.width, h, `${OUT}/overlap-${w.name}-gcal.png`, TIGHT);
}

await b.close();
rmSync(RAW, { recursive: true, force: true });
console.log("shots in", OUT);
