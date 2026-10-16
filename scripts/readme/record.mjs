// The README video's footage: a real session in the app on the made-up
// week (scripts/readme/demo.mjs), captured frame by frame at 30 fps
// (3840x2160, for a 1080p cut with room to zoom). The page runs on a fake
// clock that moves one frame per screenshot, and its CSS animations are
// slowed to match, so hovers, toasts and transitions play at their real
// speed however long a screenshot takes. A walkthrough, at a pace you can
// follow:
//   1. reconcile yesterday: ✓ on one event, then Review for the rest
//   2. annotations: the model's notes, a note of your own, dragged into place
//   3. plan Saturday: a call, then a writing block over it and the morning
//      swim (C-shape and rabbet joint)
//   4. three quick tasks that collapse into one cluster
//   PLAYWRIGHT_BROWSERS_PATH=0 node scripts/readme/record.mjs
// Writes video/public/rec/NNNN.jpg and video/src/timeline.json. DRY=1 only
// saves a still at each mark (to $TMPDIR/rec-dry), for checking the script.
// Light theme (the README's choice); MEDIA_SCHEME=dark for the dark one.
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDemo, settle } from "./page.mjs";

const DRY = !!process.env.DRY;
const scheme = process.env.MEDIA_SCHEME === "dark" ? "dark" : "light";
const FPS = 30;
const OUT = DRY ? join(process.env.TMPDIR ?? tmpdir(), "rec-dry") : "video/public/rec";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const vw = 1600;
const vh = 900;
const b = await chromium.launch();
const page = await openDemo(b, { width: vw, height: vh, dpr: DRY ? 1 : 2.4, clock: true, scheme });
const grid = page.getByTestId("week-grid");
await grid.evaluate((el) => (el.scrollTop = 7.5 * (el.scrollHeight / 24)));
await page.clock.runFor(600);

// a visible cursor (screenshots don't include the system one)
await page.addStyleTag({
  content: `#demo-cursor{position:fixed;left:800px;top:450px;width:26px;height:26px;pointer-events:none;z-index:2147483647}
  #demo-cursor svg{position:absolute;left:0;top:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
  #demo-cursor .ring{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,.85);opacity:0;transform:scale(.4)}
  #demo-cursor.down .ring{opacity:1;transform:scale(1)}`,
});
await page.evaluate(() => {
  const d = document.createElement("div");
  d.id = "demo-cursor";
  d.innerHTML =
    '<div class="ring"></div><svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 20 L8 15.5 L11.5 23 L14.5 21.6 L11 14.5 L17.5 14.5 Z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  document.body.appendChild(d);
});

// CSS animations run on the compositor's clock, not the fake one: slow them
// by how much longer a frame takes to capture than it lasts on screen
const cdp = await page.context().newCDPSession(page);
await cdp.send("Animation.enable");
async function shot(path) {
  await page.screenshot({ path, type: "jpeg", quality: 88 });
}
if (!DRY) {
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) await shot(`${OUT}/probe.jpg`);
  const perFrame = (Date.now() - t0) / 3;
  await cdp.send("Animation.setPlaybackRate", { playbackRate: Math.min(1, 1000 / FPS / perFrame) });
  rmSync(`${OUT}/probe.jpg`);
}

let f = 0;
const marks = {};
const spots = {};
async function mark(k) {
  marks[k] = f;
  if (DRY) await shot(`${OUT}/${String(f).padStart(4, "0")}-${k}.jpg`);
}
const frac = (r) => r && { x0: r.x / vw, y0: r.y / vh, x1: (r.x + r.width) / vw, y1: (r.y + r.height) / vh };
/** where something is now, as fractions of the frame (for the camera and labels) */
async function spot(k, loc) {
  spots[k] = frac(await loc.boundingBox());
}
async function snap(n = 1) {
  for (let i = 0; i < n; i++) {
    if (!DRY) await shot(`${OUT}/${String(f).padStart(4, "0")}.jpg`);
    await page.clock.runFor(1000 / FPS);
    f++;
  }
}
const cur = { x: 1000, y: 470 };
const place = (x, y) =>
  page.evaluate(([x, y]) => {
    const c = document.getElementById("demo-cursor");
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
  }, [x, y]);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, frames, linear = false) {
  const x0 = cur.x;
  const y0 = cur.y;
  for (let i = 1; i <= frames; i++) {
    const t = linear ? i / frames : ease(i / frames);
    cur.x = x0 + (x - x0) * t;
    cur.y = y0 + (y - y0) * t;
    await page.mouse.move(cur.x, cur.y);
    await place(cur.x, cur.y);
    await snap();
  }
}
async function down() {
  await page.mouse.down();
  await page.evaluate(() => document.getElementById("demo-cursor").classList.add("down"));
}
async function up() {
  await page.mouse.up();
  await page.evaluate(() => document.getElementById("demo-cursor").classList.remove("down"));
}
/** press, hold a beat, let go, then watch for `after` frames */
async function click(after = 12) {
  await down();
  await snap(4);
  await up();
  await snap(after);
}
/** about ten keys a second */
async function type(text, framesPerKey = 3) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await snap(framesPerKey);
  }
}
const center = async (loc) => {
  const r = await loc.boundingBox();
  return [r.x + r.width / 2, r.y + r.height / 2];
};
const yOf = (h) =>
  page.evaluate((h) => {
    const l = [...document.querySelectorAll(".hline")].map((x) => x.getBoundingClientRect().top);
    return l[Math.floor(h)] + (h - Math.floor(h)) * (l[1] - l[0]);
  }, h);
const satX = async () => {
  const c = await page.locator("[data-testid=day-col-6]").boundingBox();
  return c.x + c.width * 0.55;
};
const notesSettled = () => settle(page, "[data-testid=margin-notes][data-pending='0']");
/** drag out a new event on Saturday, name it, maybe file it, save */
async function create(from, to, title, { cal, travel = 22, drag = 16 } = {}) {
  const x = await satX();
  await moveTo(x, await yOf(from), travel);
  await snap(4);
  await down();
  await snap(2);
  await moveTo(x, await yOf(to), drag, true);
  await snap(2);
  await up();
  await snap(10);
  await type(title, 2);
  await snap(8);
  if (cal) {
    await moveTo(...(await center(page.getByTestId("panel-cal-trigger"))), 18);
    await click(12);
    await moveTo(...(await center(page.getByTestId("panel-cal-options").getByRole("option", { name: cal }))), 14);
    await snap(4);
    await click(10);
    // focus sits on the picker now: save with the button
    await moveTo(...(await center(page.getByTestId("event-panel").getByRole("button", { name: /^Create/ }))), 18);
    await snap(4);
    await click(2);
  } else {
    await page.keyboard.press("Enter");
  }
  await notesSettled();
  await snap(16);
}

await place(cur.x, cur.y);
const wed = page.getByTestId("day-col-3");
const fact = wed.locator(".chip-timed", { hasText: "Fact-check article" });
await spot("fact", fact);
await spot("wed", wed);
await spot("banner", page.getByTestId("sweep-banner"));

// the week
await mark("week");
await snap(2.5 * FPS);

// 1. reconcile: hover yesterday's dotted event, ✓ ...
await mark("reconcile");
const [fx, fy] = await center(fact);
await moveTo(fx - 30, fy - 4, 26);
await snap(18);
await moveTo(...(await center(fact.getByTestId("recon-yes"))), 14);
await snap(6);
await click(30);
// ... then Review steps through the rest of yesterday, one event at a time
await mark("review");
const banner = page.getByTestId("sweep-banner");
await moveTo(...(await center(banner.getByRole("button", { name: "Review" }))), 26);
await snap(6);
await click(20);
const pill = page.getByTestId("recon-pill");
await spot("pill", pill);
// revisions, coffee (the editor canceled), interview, lunch, phone in bed
for (const btn of ["recon-btn-yes", "recon-btn-canceled", "recon-btn-yes", "recon-btn-yes", "recon-btn-yes"]) {
  await moveTo(...(await center(pill.getByTestId(btn))), 12);
  await snap(4);
  await click(16);
}
await snap(30);
await mark("reconciled");

// 2. annotations: the model's notes on the week, in the free space
await mark("notes");
const research = page.getByTestId("margin-note").filter({ hasText: "Research is not writing" });
await spot("research", research);
const [rx, ry] = await center(research);
await moveTo(rx + 40, ry + 40, 30);
await snap(2.5 * FPS);
// a note of your own on the event you just confirmed
await mark("addnote");
await moveTo(fx - 20, fy, 26);
await snap(4);
await click(18);
await spot("panel", page.getByTestId("event-panel"));
await moveTo(...(await center(page.getByTestId("drill-add"))), 20);
await snap(4);
await click(8);
await type("Took two hours. Sources first.");
await snap(10);
await page.keyboard.press("Enter");
await snap(18);
await moveTo(...(await center(page.getByTestId("event-panel").locator(".panel-close").last())), 20);
await snap(4);
await click(2);
await notesSettled();
await mark("noted");
await snap(24);
// it found a spot on its own; drag it a little to taste: the arrow follows
await mark("dragnote");
const mine = page.getByTestId("margin-note").filter({ hasText: "Sources first" });
await spot("note0", mine);
const nb = await mine.boundingBox();
const fb = await fact.boundingBox();
await moveTo(nb.x + nb.width / 2, nb.y + nb.height / 2, 22);
await snap(6);
await down();
await snap(4);
// to the open space under the event, a little in from the edge
await moveTo(fb.x + 18 + nb.width / 2, fb.y + fb.height + 34 + nb.height / 2, 34);
await snap(4);
await up();
await snap(8);
await notesSettled();
await spot("note1", mine);
await moveTo(cur.x + 80, cur.y + 70, 20);
await snap(36);
await mark("annotated");

// 3. plan Saturday: a call, then a writing block over it and the swim
await mark("plan");
await create(10, 10.5, "Call with agent");
await create(11.95, 9, "Novel: chapter 9", { cal: "Homework", drag: 30 });
await moveTo((await satX()) - 260, await yOf(13.5), 20);
await mark("planned");
await snap(2.5 * FPS);

// 4. three quick tasks that overlap: one cluster
await mark("cluster");
await create(16, 16.5, "Email", { drag: 10 });
await create(16.75, 16.25, "Invoice", { travel: 16, drag: 10 });
await create(17, 16.5, "Call landlord", { travel: 16, drag: 10 });
await moveTo((await satX()) - 260, await yOf(18.5), 20);
await mark("clustered");
await snap(2.5 * FPS);
await mark("outro");
await snap(2.5 * FPS);
await mark("end");

const sat = page.locator("[data-testid=day-col-6]");
await spot("sat", sat);
await spot("swim", sat.locator(".chip-timed", { hasText: "Open water swim" }));
await spot("block", sat.locator(".chip-timed", { hasText: "Novel: chapter 9" }));
await spot("call", sat.locator(".chip-timed", { hasText: "Call with agent" }));
await spot("cluster", sat.getByTestId("cluster-block"));

writeFileSync(
  DRY ? join(OUT, "timeline.json") : "video/src/timeline.json",
  JSON.stringify({ frames: f, fps: FPS, width: 3840, height: 2160, scheme, marks, spots }, null, 2) + "\n",
);
console.log(`${f} frames (${(f / FPS).toFixed(1)}s)`, marks, DRY ? OUT : "");
await b.close();
