// Matte-star variants of the app icon (2026-10-21: "no shine around the
// north star, just matte", and more icons to pick from). Each variant is
// design/icon/north-star.svg with the halo removed and the star flat; the
// "flat" ones also drop every gradient and drop shadow.
//   PLAYWRIGHT_BROWSERS_PATH=0 node design/icon-ideas/matte.mjs
// Writes design/icon-ideas/matte/<id>.svg and design/icon-ideas/matte-sheet.png
// (each variant at Dock/Finder sizes on light and dark).
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = readFileSync("design/icon/north-star.svg", "utf8");
const CX = 745.141, CY = 370;
const star = (s, { north = 108.75, south = 76.85, side = 63.8, waist = 13.05 } = {}) => {
  const n = north * s, so = south * s, si = side * s, c = waist * s;
  return `M ${CX} ${CY - n} Q ${CX + c} ${CY - c} ${CX + si} ${CY} Q ${CX + c} ${CY + c} ${CX} ${CY + so} Q ${CX - c} ${CY + c} ${CX - si} ${CY} Q ${CX - c} ${CY - c} ${CX} ${CY - n} Z`;
};

const variants = [
  { id: "M1", name: "matte gold, thin edge", fill: "#ffd25e", stroke: "#c48a0a", sw: 4, s: 1 },
  { id: "M2", name: "matte gold, no edge", fill: "#f6c84a", stroke: "none", sw: 0, s: 1.05 },
  { id: "M3", name: "warm white, no edge", fill: "#fff1c2", stroke: "none", sw: 0, s: 1 },
  { id: "M4", name: "pure white, thin gold edge", fill: "#ffffff", stroke: "#d9a21b", sw: 4, s: 0.95 },
  { id: "M5", name: "cream, bigger", fill: "#f7e6ad", stroke: "#b8800a", sw: 5, s: 1.2 },
  { id: "M6", name: "pale gold, smaller, dark edge", fill: "#ffdf80", stroke: "#8a5d05", sw: 6, s: 0.85 },
  { id: "M7", name: "fully flat, gold star", fill: "#f6c84a", stroke: "none", sw: 0, s: 1.05, flat: true },
  { id: "M8", name: "fully flat, white star", fill: "#fff6d6", stroke: "none", sw: 0, s: 1, flat: true },
];

const build = (v) => {
  let svg = base
    // no halo
    .replace(/<circle cx="745\.141" cy="370" r="162" fill="url\(#halo\)"[^>]*\/>\s*/, "")
    // a flat star, no drop shadow
    .replace(/<path d="M 745\.141 261\.25[^"]*" fill="url\(#star\)"[^>]*\/>/,
      `<path d="${star(v.s)}" fill="${v.fill}" stroke="${v.stroke}" stroke-width="${v.sw}" stroke-linejoin="round"/>`);
  if (v.flat) {
    svg = svg
      .replace(/fill="url\(#bg\)"/, 'fill="#101a3f"')
      .replace(/fill="url\(#head\)"/, 'fill="#7b63ea"')
      .replace(/fill="url\(#today\)"/, 'fill="#e4484e"')
      .replace(/<g filter="url\(#shadow\)">/, "<g>");
  }
  return svg;
};

mkdirSync("design/icon-ideas/matte", { recursive: true });
for (const v of variants) writeFileSync(`design/icon-ideas/matte/${v.id}.svg`, build(v));
// the current icon for comparison
const current = base;

const sizes = [128, 64, 32, 16];
const card = (label, svg, dark) => `
  <div class="card ${dark ? "dark" : ""}">
    <div class="row">${sizes.map((s) => `<div class="ic" style="width:${s}px;height:${s}px">${svg.replace(/width="\d+" height="\d+"/, `width="${s}" height="${s}"`)}</div>`).join("")}</div>
    <div class="lbl">${label}</div>
  </div>`;
const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#e9e9ee;font:13px -apple-system,Helvetica,sans-serif;color:#222;padding:18px;width:1180px}
  h1{font-size:15px;margin:0 0 10px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .card{background:#f7f7f9;border-radius:12px;padding:12px 14px}
  .card.dark{background:#1c1c21;color:#ddd}
  .row{display:flex;align-items:flex-end;gap:18px;height:132px}
  .ic svg{display:block}
  .lbl{margin-top:8px;font-weight:600}
</style>
<h1>North Star icon — matte star variants (current icon first), at 128 / 64 / 32 / 16 px, light and dark Dock</h1>
<div class="grid">
${card("current (glow + gloss)", current, false)}${card("current (glow + gloss)", current, true)}
${variants.flatMap((v) => [card(`${v.id} — ${v.name}`, build(v), false), card(`${v.id} — ${v.name}`, build(v), true)]).join("")}
</div>`;
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1216, height: 1800 }, deviceScaleFactor: 2 })).newPage();
await page.setContent(html);
await page.screenshot({ path: "design/icon-ideas/matte-sheet.png", fullPage: true });
await b.close();
console.log("wrote design/icon-ideas/matte-sheet.png and matte/M1..M8.svg");
