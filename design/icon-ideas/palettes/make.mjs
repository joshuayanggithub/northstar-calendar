// Palette variations of the app icon ("Polaris is today", design/icon/north-star.svg):
// the same geometry, recoloured so the calendar stands off the background and
// the north star reads first. Writes one SVG per variant and sheet.png, a
// comparison at Dock / Finder / list sizes on light and dark desktops.
//   PLAYWRIGHT_BROWSERS_PATH=0 node design/icon-ideas/palettes/make.mjs
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const OUT = "design/icon-ideas/palettes";
const COLS = 7, ROWS = 5;
const X0 = 247, DX = 77.714, CW = 63.714, Y0 = 416, DY = 73.6, CH = 61.6;
// the Little Dipper: the bowl (cols 1-2, rows 3-4), then the handle up to today
const ON = new Set(["1,3", "1,4", "2,3", "2,4", "3,2", "4,2", "5,1"]);
const cx = (c) => X0 + c * DX + CW / 2, cy = (r) => Y0 + r * DY + CH / 2;

function star(x, y, s) {
  const up = 75 * s, side = 44 * s, down = 53 * s, k = 9 * s;
  return `M ${x} ${y - up} Q ${x + k} ${y - k} ${x + side} ${y} Q ${x + k} ${y + k} ${x} ${y + down} Q ${x - k} ${y + k} ${x - side} ${y} Q ${x - k} ${y - k} ${x} ${y - up} Z`;
}

/** a starry sky: dots of every size and brightness, a few four-point
 *  sparkles, all off the calendar page and inside the tile (seeded, so a
 *  variant always draws the same sky) */
function starfield(color, n, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const onPage = (px, py) => px > 190 && px < 834 && py > 205 && py < 822;
  const inTile = (px, py) => {
    const r = 186, l = 100 + r, h = 924 - r;
    const qx = Math.min(Math.max(px, l), h), qy = Math.min(Math.max(py, l), h);
    return Math.hypot(px - qx, py - qy) < r - 14;
  };
  const out = [];
  let tries = 0;
  while (out.length < n && tries++ < 5000) {
    const px = 110 + rnd() * 804, py = 110 + rnd() * 804;
    if (onPage(px, py) || !inTile(px, py)) continue;
    const big = rnd() < 0.12;
    const r = big ? 4 + rnd() * 2.5 : 1.4 + rnd() * 2.6;
    const o = (0.35 + rnd() * 0.65).toFixed(2);
    if (big && rnd() < 0.6) {
      const k = r * 3.2, w = r * 0.55;
      out.push(`<path d="M${px} ${py - k} Q${px + w} ${py - w} ${px + k} ${py} Q${px + w} ${py + w} ${px} ${py + k} Q${px - w} ${py + w} ${px - k} ${py} Q${px - w} ${py - w} ${px} ${py - k}Z" fill="${color}" opacity="${o}"/>`);
    } else out.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="${o}"/>`);
  }
  return out.join("");
}

function svg(p) {
  const cells = [];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    if (c === 6 && r === 0) continue;
    cells.push(`<rect x="${X0 + c * DX}" y="${Y0 + r * DY}" width="${CW}" height="${CH}" rx="12" fill="${ON.has(`${c},${r}`) ? p.cellOn : p.cell}"/>`);
  }
  const bowl = [[1, 4], [2, 4], [2, 3], [1, 3], [1, 4]].map(([c, r]) => `${cx(c)},${cy(r)}`).join(" ");
  const handle = [[2, 3], [3, 2], [4, 2], [5, 1], [6, 0]].map(([c, r]) => `${cx(c)},${cy(r)}`).join(" ");
  const dots = [[1, 4], [2, 4], [2, 3], [1, 3], [3, 2], [4, 2], [5, 1]].map(([c, r]) => `<circle cx="${cx(c)}" cy="${cy(r)}" r="12" fill="${p.path}"/>`).join("");
  const sx = p.starX ?? cx(6), sy = p.starY ?? 391;
  // a star out in the sky is tied to the today square by a thin line
  const tether = p.starX
    ? `<line x1="${cx(6)}" y1="${Y0 + 4}" x2="${sx}" y2="${sy + 40 * (p.starScale ?? 1)}" stroke="${p.tether ?? p.path}" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 16" opacity=".9"/>`
    : "";
  const sky = p.starfield
    ? starfield(p.skyDots, p.starfield)
    : p.skyDots
    ? [[170, 190, 5], [880, 230, 4], [150, 620, 3.5], [890, 700, 4.5], [520, 165, 3], [250, 870, 3], [820, 880, 3.5]]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${p.skyDots}"/>`).join("")
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.bg[0]}"/><stop offset="1" stop-color="${p.bg[1]}"/></linearGradient>
  <linearGradient id="head" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.head[0]}"/><stop offset="1" stop-color="${p.head[1] ?? p.head[0]}"/></linearGradient>
  <linearGradient id="star" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.star[0]}"/><stop offset="1" stop-color="${p.star[1]}"/></linearGradient>
  <linearGradient id="today" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.today[0]}"/><stop offset="1" stop-color="${p.today[1]}"/></linearGradient>
  <radialGradient id="halo"><stop offset="0" stop-color="${p.halo ?? "#fff6d8"}" stop-opacity=".9"/><stop offset=".45" stop-color="${p.halo ?? "#ffe9a6"}" stop-opacity=".35"/><stop offset="1" stop-color="${p.halo ?? "#ffe9a6"}" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity="${p.shadow ?? 0.3}"/></filter>
  <filter id="starShadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="${p.starShadow ?? "#7a4a00"}" flood-opacity=".45"/></filter>
  <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
</defs><rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>${sky}
  <g filter="url(#shadow)"><rect x="204" y="268" width="616" height="540" rx="60" fill="${p.page}"${p.pageEdge ? ` stroke="${p.pageEdge}" stroke-width="6"` : ""}/>
  <path d="M204 328 a60 60 0 0 1 60 -60 h496 a60 60 0 0 1 60 60 v52 h-616z" fill="url(#head)"/></g>
  <rect x="332" y="218" width="34" height="96" rx="17" fill="${p.rings}"/><rect x="658" y="218" width="34" height="96" rx="17" fill="${p.rings}"/>
  ${cells.join("")}
  <polyline points="${bowl}" fill="none" stroke="${p.path}" stroke-width="11" stroke-linejoin="round"/>
  <polyline points="${handle}" fill="none" stroke="${p.path}" stroke-width="11" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  <rect x="704.29" y="407" width="81.71" height="79.6" rx="14" fill="url(#today)"/>
  ${tether}
  ${p.glow ? `<circle cx="${sx}" cy="${sy}" r="${120 * p.glow}" fill="url(#halo)" clip-path="url(#tile)"/>` : ""}
  <path d="${star(sx, sy, p.starScale ?? 1)}" fill="url(#star)" stroke="${p.starStroke}" stroke-width="${p.starStrokeW ?? 4}" filter="url(#starShadow)"/></svg>`;
}

export const VARIANTS = [
  { key: "now", name: "Current", note: "navy header on navy",
    bg: ["#0d1630", "#1f2d57"], page: "#f6f2e9", head: ["#1f2d57"], rings: "#e6a51c", cell: "#ddd6c9", cellOn: "#e9dcbc",
    path: "#c98f12", today: ["#f05a5f", "#d8393f"], star: ["#ffe490", "#e6a51c"], starStroke: "#a86f05" },
  { key: "gold", name: "A · Gold header", note: "the page's head in gold; a big star outlined in navy so it parts from the gold",
    bg: ["#0b1230", "#1b2754"], page: "#f7f3ea", head: ["#f6c449", "#dc9c13"], rings: "#f7f3ea", cell: "#ded7ca", cellOn: "#f1ddaa",
    path: "#b8860b", today: ["#f05a5f", "#d8393f"], star: ["#fffbe8", "#ffd25e"], starStroke: "#0b1230", starStrokeW: 8, starScale: 1.45, starY: 372, starShadow: "#0b1230" },
  { key: "sky", name: "B · Night sky", note: "starry navy, a bright blue head, glowing star",
    bg: ["#070d24", "#1a2450"], skyDots: "#cfd8ff", page: "#f7f4ee", head: ["#4f86f7", "#2f5fd6"], rings: "#ffd25e", cell: "#ddd8cf", cellOn: "#f0dfb0",
    path: "#c48a0a", today: ["#f05a5f", "#d8393f"], star: ["#ffffff", "#ffd25e"], starStroke: "#c48a0a", starScale: 1.45, glow: 1.35, starY: 370 },
  { key: "dawn", name: "C · Dawn", note: "light sky, navy calendar head, gold star outlined",
    bg: ["#e4ecff", "#b7c6f2"], page: "#ffffff", head: ["#1f2d57"], rings: "#e6a51c", cell: "#e3e6ee", cellOn: "#fbe7b5",
    path: "#1f2d57", today: ["#f05a5f", "#d8393f"], star: ["#ffe27a", "#f0a90f"], starStroke: "#1f2d57", starStrokeW: 7, starScale: 1.4, starY: 372, shadow: 0.18, starShadow: "#1f2d57" },
  { key: "red", name: "D · Classic red", note: "a red calendar head (like Calendar's); the today square turns gold",
    bg: ["#0d1630", "#1f2d57"], page: "#f7f3ea", head: ["#ef4e4f", "#cf3236"], rings: "#f7f3ea", cell: "#ddd6c9", cellOn: "#f1ddaa",
    path: "#c48a0a", today: ["#ffd25e", "#e3a417"], star: ["#ffffff", "#ffe08a"], starStroke: "#c48a0a", starScale: 1.4, glow: 1.25, starY: 372 },
  { key: "cream", name: "E · Paper", note: "warm paper ground, navy head and constellation, gold star",
    bg: ["#fbf3e2", "#ecdcbd"], page: "#ffffff", pageEdge: "#e6d6b6", head: ["#22305e"], rings: "#22305e", cell: "#ece6da", cellOn: "#f8e3ad",
    path: "#22305e", today: ["#f05a5f", "#d8393f"], star: ["#ffe27a", "#f0a90f"], starStroke: "#22305e", starStrokeW: 7, starScale: 1.4, starY: 372, shadow: 0.15, starShadow: "#22305e" },
  { key: "skystar", name: "F · Star in the sky", note: "a pale-blue head off navy; the star out in the sky, glowing, tied to today",
    bg: ["#081030", "#1d2a5c"], skyDots: "#c9d4ff", page: "#f7f4ee", head: ["#cfdcff", "#a9bff5"], rings: "#ffd25e", cell: "#ddd8cf", cellOn: "#f0dfb0",
    path: "#c48a0a", tether: "#ffd25e", today: ["#f05a5f", "#d8393f"], star: ["#ffffff", "#ffd25e"], starStroke: "#e0a516", starStrokeW: 3,
    starScale: 1.5, glow: 1.5, halo: "#fff3c4", starX: 770, starY: 222 },
  { key: "paperstar", name: "G · Paper, star in the sky", note: "warm paper ground; navy head; a big gold star above the page, tied to today",
    bg: ["#fbf3e2", "#ecdcbd"], page: "#ffffff", pageEdge: "#e6d6b6", head: ["#22305e"], rings: "#22305e", cell: "#ece6da", cellOn: "#f8e3ad",
    path: "#22305e", tether: "#22305e", today: ["#f05a5f", "#d8393f"], star: ["#ffe27a", "#f0a90f"], starStroke: "#22305e", starStrokeW: 7,
    starScale: 1.5, starX: 770, starY: 222, shadow: 0.15, starShadow: "#22305e" },
];

// B, with a starrier sky, in a range of calendar-head colours
const B = { bg: ["#060b22", "#19234f"], skyDots: "#dfe6ff", starfield: 70, page: "#f7f4ee", rings: "#ffd25e", cell: "#ddd8cf",
  cellOn: "#f0dfb0", path: "#c48a0a", today: ["#f05a5f", "#d8393f"], star: ["#ffffff", "#ffd25e"], starStroke: "#c48a0a",
  starScale: 1.45, glow: 1.35, starY: 370 };
export const HEADS = [
  { key: "b-blue", name: "Blue (B)", head: ["#4f86f7", "#2f5fd6"] },
  { key: "b-sky", name: "Sky", head: ["#7cc3ff", "#3d92ea"] },
  { key: "b-teal", name: "Teal", head: ["#3cc8bd", "#1f968f"] },
  { key: "b-violet", name: "Violet", head: ["#9a86ff", "#6a52e0"] },
  { key: "b-lavender", name: "Lavender", head: ["#c3ccff", "#93a2f2"] },
  { key: "b-mint", name: "Mint", head: ["#6fdcb0", "#2fae80"] },
  { key: "b-coral", name: "Coral", head: ["#ff8a6e", "#ec5f47"], today: ["#ffd25e", "#e3a417"] },
  { key: "b-white", name: "Frost", head: ["#ffffff", "#dfe5f5"], rings: "#ffd25e" },
].map((h) => ({ ...B, ...h, note: "" }));

for (const v of [...VARIANTS, ...HEADS]) writeFileSync(`${OUT}/${v.key}.svg`, svg(v));

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1500, height: 400 }, deviceScaleFactor: 2 });
const img = (v, s) => `<img src="data:image/svg+xml;base64,${Buffer.from(svg(v)).toString("base64")}" width="${s}" height="${s}">`;
const row = (v) => `<div class="row"><div class="lab"><b>${v.name}</b><span>${v.note}</span></div>
  <div class="bg dark">${img(v, 200)}${img(v, 64)}${img(v, 32)}${img(v, 18)}</div>
  <div class="bg light">${img(v, 200)}${img(v, 64)}${img(v, 32)}${img(v, 18)}</div></div>`;
await page.setContent(`<!doctype html><html><head><style>
  body{margin:0;padding:20px;background:#fff;font:14px -apple-system,system-ui,sans-serif;color:#222}
  .row{display:flex;align-items:center;gap:16px;margin-bottom:14px}
  .lab{width:230px;display:flex;flex-direction:column;gap:4px}.lab span{color:#666;font-size:12.5px}
  .bg{display:flex;align-items:center;gap:22px;padding:14px 22px;border-radius:14px}
  .dark{background:#1e1e1e}.light{background:#ececec}
  .hd{display:flex;gap:16px;margin:0 0 8px 246px;color:#888;font-size:12px}.hd div{width:451px}
</style></head><body><div class="hd"><div>dark desktop · Dock 200 · 64 · Finder 32 · list 18</div><div>light desktop</div></div>${VARIANTS.map(row).join("")}</body></html>`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/sheet.png`, fullPage: true });
await page.setViewportSize({ width: 1400, height: 400 });
const cell = (v) => `<div class="c"><b>${v.name}</b><div class="bg dark">${img(v, 210)}</div><div class="sm"><span class="bg dark">${img(v, 64)}${img(v, 32)}</span><span class="bg light">${img(v, 64)}${img(v, 32)}</span></div></div>`;
await page.setContent(`<!doctype html><html><head><style>
  body{margin:0;padding:20px;background:#fff;font:14px -apple-system,system-ui,sans-serif;color:#222}
  .grid{display:grid;grid-template-columns:repeat(4,320px);gap:22px}
  .c{display:flex;flex-direction:column;gap:8px;align-items:center}
  .bg{display:flex;align-items:center;justify-content:center;gap:14px;padding:12px 16px;border-radius:12px}
  .dark{background:#1e1e1e}.light{background:#ececec}
  .sm{display:flex;gap:8px}
</style></head><body><div class="grid">${HEADS.map(cell).join("")}</div></body></html>`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/heads.png`, fullPage: true });
await b.close();
console.log("wrote", OUT);
