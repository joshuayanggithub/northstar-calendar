// The README video's footage: a real session in the app on the made-up
// week (scripts/readme/demo.mjs), captured frame by frame at 30 fps so the
// cursor moves smoothly and every frame is sharp (3840x2160 for a 1080p cut
// with room to zoom). The session: reconcile yesterday, then plan Saturday
// (a call, then a writing block over it and the morning swim: C-shape and
// rabbet joint), then three quick tasks that collapse into a cluster.
//   PLAYWRIGHT_BROWSERS_PATH=0 node scripts/readme/record.mjs
// Writes video/public/rec/NNNN.jpg and video/src/timeline.json.
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { openDemo } from "./page.mjs";

const OUT = "video/public/rec";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const page = await openDemo(b, { width: 1600, height: 900, dpr: 2.4 });
const grid = page.getByTestId("week-grid");
await grid.evaluate((el) => (el.scrollTop = 7.5 * (el.scrollHeight / 24)));
await page.waitForTimeout(600);

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

let f = 0;
const marks = {};
const mark = (k) => (marks[k] = f);
async function snap(n = 1) {
  for (let i = 0; i < n; i++) {
    await page.screenshot({ path: `${OUT}/${String(f).padStart(4, "0")}.jpg`, type: "jpeg", quality: 90 });
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
async function click(frames = 3) {
  await down();
  await snap(2);
  await up();
  await snap(frames);
}
async function type(text, perFrame = 2) {
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    if (i % perFrame === perFrame - 1 || i === text.length - 1) await snap();
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
/** drag out a new event on Saturday, name it, maybe file it, save */
async function create(from, to, title, { cal, travel = 12, drag = 12 } = {}) {
  const x = await satX();
  await moveTo(x, await yOf(from), travel);
  await down();
  await snap();
  await moveTo(x, await yOf(to), drag, true);
  await up();
  await page.waitForTimeout(120);
  await snap(2);
  await type(title);
  if (cal) {
    await moveTo(...(await center(page.getByTestId("panel-cal-trigger"))), 8);
    await click(2);
    await moveTo(...(await center(page.getByTestId("panel-cal-options").getByRole("option", { name: cal }))), 6);
    await click(2);
    // focus sits on the picker now: save with the button
    await moveTo(...(await center(page.getByTestId("event-panel").getByRole("button", { name: /^Create/ }))), 9);
    await click(1);
  } else {
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(150);
  await page.locator("[data-testid=margin-notes][data-pending='0']").waitFor({ timeout: 5000 }).catch(() => {});
  await snap(2);
}

await place(cur.x, cur.y);
// 1. the week
mark("week");
await snap(18);

// 2. reconcile: yesterday's unconfirmed event, ✓
mark("reconcile");
const fact = page.locator("[data-testid=day-col-3] .chip-timed", { hasText: "Fact-check article" });
const [fx, fy] = await center(fact);
await moveTo(fx - 20, fy, 16);
await snap(4);
await moveTo(...(await center(fact.getByTestId("recon-yes"))), 9);
await click(4);
await moveTo(fx - 60, fy + 70, 8);
await snap(8);
mark("reconciled");

// 3. plan Saturday: a call, then a writing block over it and the swim
mark("plan");
await create(10, 10.5, "Call with agent", { travel: 14, drag: 8 });
await create(11.95, 9, "Novel: chapter 9", { cal: "Homework", travel: 10, drag: 14 });
await moveTo((await satX()) - 260, await yOf(13.5), 8);
mark("planned");
await snap(22);

// 4. three quick tasks that overlap: one cluster
mark("cluster");
await create(16, 16.5, "Email", { travel: 10, drag: 6 });
await create(16.75, 16.25, "Invoice", { travel: 6, drag: 6 });
await create(17, 16.5, "Call landlord", { travel: 6, drag: 6 });
await moveTo((await satX()) - 260, await yOf(18.5), 8);
mark("clustered");
await snap(18);
mark("end");

// where the features ended up, as fractions of the frame, for the labels
const vw = 1600;
const vh = 900;
const frac = (r) => r && { x0: r.x / vw, y0: r.y / vh, x1: (r.x + r.width) / vw, y1: (r.y + r.height) / vh };
const sat = page.locator("[data-testid=day-col-6]");
const spots = {
  swim: frac(await sat.locator(".chip-timed", { hasText: "Open water swim" }).boundingBox()),
  block: frac(await sat.locator(".chip-timed", { hasText: "Novel: chapter 9" }).boundingBox()),
  call: frac(await sat.locator(".chip-timed", { hasText: "Call with agent" }).boundingBox()),
  cluster: frac(await sat.getByTestId("cluster-block").boundingBox()),
  fact: frac(await page.locator("[data-testid=day-col-3] .chip-timed", { hasText: "Fact-check article" }).boundingBox()),
  banner: frac(await page.getByTestId("sweep-banner").boundingBox()),
};

writeFileSync("video/src/timeline.json", JSON.stringify({ frames: f, fps: 30, width: 3840, height: 2160, marks, spots }, null, 2) + "\n");
console.log(`${f} frames`, marks);
await b.close();
