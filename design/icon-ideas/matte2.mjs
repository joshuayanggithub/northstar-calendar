// Round 2 on M2 (matte gold star, no edge): more and bigger background
// stars × blue/purple header colours (2026-10-21).
//   PLAYWRIGHT_BROWSERS_PATH=0 node design/icon-ideas/matte2.mjs
// Writes design/icon-ideas/matte2/<field>-<head>.svg and matte2-sheet.png.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const base = readFileSync("design/icon/north-star.svg", "utf8");
const CX = 745.141, CY = 370;
const polaris = (s) => {
  const n = 108.75 * s, so = 76.85 * s, si = 63.8 * s, c = 13.05 * s;
  return `M ${CX} ${CY - n} Q ${CX + c} ${CY - c} ${CX + si} ${CY} Q ${CX + c} ${CY + c} ${CX} ${CY + so} Q ${CX - c} ${CY + c} ${CX - si} ${CY} Q ${CX - c} ${CY - c} ${CX} ${CY - n} Z`;
};
// a 4-point sparkle, as the current field's few big ones
const sparkle = (x, y, r) => `M ${x} ${y - r} Q ${x + r * 0.2} ${y - r * 0.2} ${x + r} ${y} Q ${x + r * 0.2} ${y + r * 0.2} ${x} ${y + r} Q ${x - r * 0.2} ${y + r * 0.2} ${x - r} ${y} Q ${x - r * 0.2} ${y - r * 0.2} ${x} ${y - r} Z`;

// seeded field of stars inside the tile, outside the page (and its shadow)
const field = ({ count, size, sparkles, seed }) => {
  let t = seed;
  const rnd = () => ((t = (t * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const inPage = (x, y) => x > 190 && x < 834 && y > 206 && y < 836;
  const nearPolaris = (x, y) => Math.hypot(x - CX, y - CY) < 150;
  const out = [];
  let made = 0, guard = 0;
  while (made < count && guard++ < 20000) {
    const x = 150 + rnd() * 724, y = 150 + rnd() * 724; // well inside the tile
    if (inPage(x, y) || nearPolaris(x, y)) continue;
    // keep inside the rounded tile corners
    const dx = Math.max(0, Math.abs(x - 512) - (412 - 186)), dy = Math.max(0, Math.abs(y - 512) - (412 - 186));
    if (Math.hypot(dx, dy) > 186 - 56) continue;
    const r = (1.4 + rnd() * rnd() * 4.5) * size;
    const op = (0.45 + rnd() * 0.55).toFixed(2);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#e4eaff" opacity="${op}"/>`);
    made++;
  }
  for (let i = 0; i < sparkles; i++) {
    let x, y;
    do { x = 160 + rnd() * 704; y = 160 + rnd() * 704; } while (inPage(x, y) || nearPolaris(x, y) || Math.hypot(Math.max(0, Math.abs(x - 512) - 226), Math.max(0, Math.abs(y - 512) - 226)) > 120);
    const r = (9 + rnd() * 9) * size;
    out.push(`<path d="${sparkle(x, y, r)}" fill="#e4eaff" opacity="${(0.6 + rnd() * 0.4).toFixed(2)}"/>`);
  }
  return out.join("");
};

// (the current icon has ~80 small stars: every field here has far fewer,
// and bigger)
const FIELDS = {
  S1: { name: "12 stars", count: 12, size: 2.0, sparkles: 3, seed: 7 },
  S2: { name: "20 stars", count: 20, size: 1.7, sparkles: 4, seed: 11 },
  S3: { name: "30 stars", count: 30, size: 1.5, sparkles: 4, seed: 23 },
  S4: { name: "45 stars", count: 45, size: 1.3, sparkles: 5, seed: 31 },
};
// flat (matte) header colours, no gradient
const HEADS = {
  V: { name: "violet", c: "#7d66ea" },
  H1: { name: "indigo", c: "#5f6de0" },
  H2: { name: "royal blue", c: "#4a6fe3" },
  H3: { name: "deep purple", c: "#6a4ad6" },
  H4: { name: "periwinkle", c: "#8d7ff0" },
  H5: { name: "sky", c: "#4f8de0" },
};

const build = (f, h) => base
  // the whole old star field: everything between the tile and the page
  .replace(/(<rect x="100" y="100" width="824" height="824" rx="186" fill="url\(#bg\)"\/>)[\s\S]*?(?=<g filter="url\(#shadow\)">)/, (_, tile) => tile + field(FIELDS[f]))
  .replace(/<circle cx="745\.141" cy="370" r="162" fill="url\(#halo\)"[^>]*\/>\s*/, "")
  .replace(/<path d="M 745\.141 261\.25[^"]*" fill="url\(#star\)"[^>]*\/>/, `<path d="${polaris(1.05)}" fill="#f6c84a"/>`)
  .replace(/fill="url\(#head\)"/, `fill="${HEADS[h].c}"`);

mkdirSync("design/icon-ideas/matte2", { recursive: true });
const cards = [];
for (const f of Object.keys(FIELDS)) for (const h of Object.keys(HEADS)) {
  const svg = build(f, h);
  writeFileSync(`design/icon-ideas/matte2/${f}-${h}.svg`, svg);
  cards.push({ id: `${f}-${h}`, name: `${FIELDS[f].name} · ${HEADS[h].name}`, svg });
}
const sizes = [128, 48, 24];
// inline SVGs on one page share ids (the first #head won for every card):
// each card gets its own
const ns = (svg, tag) => svg.replace(/id="([a-zA-Z]+)"/g, `id="$1-${tag}"`).replace(/url\(#([a-zA-Z]+)\)/g, `url(#$1-${tag})`);
const card = (c) => `<div class="card"><div class="row">${sizes.map((s) => `<div style="width:${s}px;height:${s}px">${ns(c.svg, `${c.id}-${s}`).replace(/width="\d+" height="\d+"/, `width="${s}" height="${s}"`)}</div>`).join("")}</div><div class="lbl">${c.id} — ${c.name}</div></div>`;
const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#2a2a30;font:13px -apple-system,Helvetica,sans-serif;color:#eee;padding:18px;width:1240px}
  h1{font-size:15px;margin:0 0 10px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  .card{background:#3a3a42;border-radius:12px;padding:12px 14px}
  .row{display:flex;align-items:flex-end;gap:12px;height:132px}
  .lbl{margin-top:8px;font-weight:600}
  .sec{grid-column:1/-1;font-weight:700;margin-top:6px;color:#bbb}
</style>
<h1>M2 star · smaller stars inside the frame, S1–S4 · flat matte header colours V, H1–H5 (128 / 48 / 24 px)</h1>
<div class="grid">${Object.keys(FIELDS).map((f) => `<div class="sec">${f} — ${FIELDS[f].name}</div>` + cards.filter((c) => c.id.startsWith(f)).map(card).join("")).join("")}</div>`;
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1276, height: 1800 }, deviceScaleFactor: 2 })).newPage();
await page.setContent(html);
await page.screenshot({ path: "design/icon-ideas/matte2-sheet.png", fullPage: true });
await b.close();
console.log("wrote design/icon-ideas/matte2-sheet.png and matte2/*.svg");
