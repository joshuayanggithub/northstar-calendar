import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

// a four-point "north star": concave sides; the north ray can be longer
const star = (cx, cy, R, { north = R, south = R, side = R * 0.78, waist = 0.16 } = {}) => {
  const c = R * waist;
  return `M ${cx} ${cy - north} Q ${cx + c} ${cy - c} ${cx + side} ${cy} Q ${cx + c} ${cy + c} ${cx} ${cy + south} Q ${cx - c} ${cy + c} ${cx - side} ${cy} Q ${cx - c} ${cy - c} ${cx} ${cy - north} Z`;
};
const tile = (fill, extra = "") => `<rect x="100" y="100" width="824" height="824" rx="186" fill="${fill}" ${extra}/>`;
const defs = `
<defs>
  <linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1630"/><stop offset="1" stop-color="#1f2d57"/></linearGradient>
  <linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1630"/><stop offset=".62" stop-color="#3a3466"/><stop offset="1" stop-color="#c9774f"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#e2a41f"/></linearGradient>
  <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf8f1"/><stop offset="1" stop-color="#efe8da"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#ffd75e" stop-opacity=".75"/><stop offset="1" stop-color="#ffd75e" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".28"/></filter>
</defs>`;

const icons = {
  A: { name: "Polaris page", svg: `${defs}${tile("url(#night)")}
    <g filter="url(#shadow)"><rect x="236" y="268" width="552" height="520" rx="70" fill="#f6f2e9"/>
    <path d="M236 338 a70 70 0 0 1 70 -70 h412 a70 70 0 0 1 70 70 v52 h-552z" fill="#e5484d"/></g>
    <rect x="352" y="222" width="34" height="100" rx="17" fill="#c9cfdb"/><rect x="638" y="222" width="34" height="100" rx="17" fill="#c9cfdb"/>
    ${[0, 1, 2, 3].flatMap((c) => [0, 1, 2].map((r) => (c === 2 && r === 1 ? "" : `<rect x="${292 + c * 118}" y="${438 + r * 104}" width="82" height="72" rx="18" fill="#dcd6ca"/>`))).join("")}
    <circle cx="569" cy="578" r="120" fill="url(#glow)"/>
    <path d="${star(569, 578, 92, { north: 112, south: 84, side: 70 })}" fill="url(#gold)" stroke="#b9800f" stroke-width="4"/>` },
  B: { name: "Compass week", svg: `${defs}${tile("url(#night)")}
    <circle cx="512" cy="530" r="282" fill="none" stroke="#33467a" stroke-width="10"/>
    ${[...Array(7).keys()].map((i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 7; const x = 512 + 282 * Math.cos(a), y = 530 + 282 * Math.sin(a); return i === 0 ? "" : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="26" fill="#8fa3d6"/>`; }).join("")}
    <path d="M512 530 L497 330 L512 300 L527 330 Z" fill="url(#gold)"/>
    <path d="M512 530 L500 690 L512 712 L524 690 Z" fill="#4b5f96"/>
    <circle cx="512" cy="530" r="30" fill="#f6f2e9"/>
    <circle cx="512" cy="248" r="110" fill="url(#glow)"/>
    <path d="${star(512, 248, 74, { north: 92, south: 66, side: 58 })}" fill="url(#gold)"/>` },
  C: { name: "Little Dipper", svg: `${defs}${tile("url(#night)")}
    ${[...Array(7).keys()].flatMap((c) => [...Array(5).keys()].map((r) => `<circle cx="${236 + c * 92}" cy="${330 + r * 100}" r="9" fill="#3c4f86"/>`)).join("")}
    <polyline points="420,730 512,630 604,630 696,530 696,430 788,330" fill="none" stroke="#e8b33a" stroke-width="10" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>
    <polyline points="420,730 328,730 328,630 420,630 420,730" fill="none" stroke="#e8b33a" stroke-width="10" stroke-linejoin="round" opacity=".85"/>
    ${[[420, 730], [512, 630], [604, 630], [696, 530], [696, 430], [328, 730], [328, 630], [420, 630]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="20" fill="#ffe08a"/>`).join("")}
    <circle cx="788" cy="300" r="150" fill="url(#glow)"/>
    <path d="${star(788, 310, 96, { north: 118, south: 86, side: 74 })}" fill="url(#gold)"/>` },
  D: { name: "Star over the horizon", svg: `${defs}${tile("url(#dusk)")}
    ${[0, 1, 2, 3].map((i) => `<rect x="${196 + i * 6}" y="${676 + i * 56}" width="${632 - i * 12}" height="${14 - i * 2}" rx="6" fill="#f6f2e9" opacity="${0.75 - i * 0.15}"/>`).join("")}
    ${[...Array(7).keys()].map((c) => `<rect x="${226 + c * 84}" y="604" width="40" height="40" rx="10" fill="#f6f2e9" opacity="${c === 3 ? 0.95 : 0.35}"/>`).join("")}
    <circle cx="512" cy="356" r="200" fill="url(#glow)"/>
    <path d="${star(512, 360, 150, { north: 190, south: 128, side: 112 })}" fill="url(#gold)"/>` },
  E: { name: "Star page", svg: `${defs}${tile("url(#cream)")}
    <rect x="100" y="100" width="824" height="824" rx="186" fill="none" stroke="#e3dccd" stroke-width="4"/>
    <rect x="330" y="150" width="40" height="120" rx="20" fill="#9aa3b8"/><rect x="654" y="150" width="40" height="120" rx="20" fill="#9aa3b8"/>
    <path d="${star(512, 566, 250, { north: 330, south: 220, side: 220, waist: 0.12 })}" fill="#1d2b57"/>
    <circle cx="512" cy="566" r="34" fill="url(#gold)"/>` },
  F: { name: "Reaching columns", svg: `${defs}${tile("url(#cream)")}
    <rect x="100" y="100" width="824" height="824" rx="186" fill="none" stroke="#e3dccd" stroke-width="4"/>
    ${[[0, 560, "#b9c4ec"], [1, 470, "#f2cdb8"], [2, 300, "#1d2b57"], [3, 520, "#cfe3c7"], [4, 610, "#e6d3f0"]].map(([i, top, f]) => `<rect x="${206 + i * 128}" y="${top}" width="100" height="${810 - top}" rx="26" fill="${f}"/>`).join("")}
    <circle cx="512" cy="228" r="120" fill="url(#glow)"/>
    <path d="${star(512, 222, 86, { north: 106, south: 78, side: 66 })}" fill="url(#gold)" stroke="#b9800f" stroke-width="3"/>` },
};
const svgDoc = (inner, size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">${inner}</svg>`;
for (const [k, v] of Object.entries(icons)) writeFileSync(`design/icon-ideas/${k}.svg`, svgDoc(v.svg, 1024));

const cards = Object.entries(icons).map(([k, v]) => `
  <div class="card"><div class="big">${svgDoc(v.svg, 300)}</div>
  <div class="small">${svgDoc(v.svg, 64)}${svgDoc(v.svg, 32)}<span class="dock">Dock · menu</span></div>
  <div class="name"><b>${k}</b> ${v.name}</div></div>`).join("");
const html = `<!doctype html><body style="margin:0;background:#f4f3ef;font:15px -apple-system,sans-serif;color:#2b2b2b">
<style>.grid{display:grid;grid-template-columns:repeat(3,340px);gap:18px;padding:24px}.card{background:#fff;border-radius:16px;padding:16px 18px 14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.big{display:flex;justify-content:center}.small{display:flex;align-items:center;gap:12px;margin:8px 0 4px 8px}.dock{color:#999;font-size:12px}.name{margin-left:8px}</style>
<div class="grid" id="g">${cards}</div></body>`;
writeFileSync("design/icon-ideas/sheet.html", html);
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1140, height: 900 }, deviceScaleFactor: 2 })).newPage();
await page.goto(`file://${process.cwd()}/design/icon-ideas/sheet.html`);
await page.locator("#g").screenshot({ path: "design/icon-ideas/north-star-icon-ideas.png" });
await b.close();
console.log("ok");
