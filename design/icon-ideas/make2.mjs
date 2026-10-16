import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const star = (cx, cy, R, { north = R, south = R, side = R * 0.78, waist = 0.16 } = {}) => {
  const c = R * waist;
  return `M ${cx} ${cy - north} Q ${cx + c} ${cy - c} ${cx + side} ${cy} Q ${cx + c} ${cy + c} ${cx} ${cy + south} Q ${cx - c} ${cy + c} ${cx - side} ${cy} Q ${cx - c} ${cy - c} ${cx} ${cy - north} Z`;
};
const defs = `<defs>
  <linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1630"/><stop offset="1" stop-color="#1f2d57"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset="1" stop-color="#e2a41f"/></linearGradient>
  <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf8f1"/><stop offset="1" stop-color="#efe8da"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="#ffd75e" stop-opacity=".8"/><stop offset="1" stop-color="#ffd75e" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".3"/></filter>
</defs>`;
const tile = (fill) => `<rect x="100" y="100" width="824" height="824" rx="186" fill="${fill}"/>`;
// a month page: 7 columns x 5 weeks of day cells
const P = { x: 204, y: 268, w: 616, h: 540, head: 112 };
const cols = 7, rows = 5, padX = 36, padY = 30;
const cw = (P.w - 2 * padX) / cols, ch = (P.h - P.head - 2 * padY) / rows;
const cell = (c, r) => ({ x: P.x + padX + c * cw, y: P.y + P.head + padY + r * ch, cx: P.x + padX + c * cw + cw / 2, cy: P.y + P.head + padY + r * ch + ch / 2 });
// the Little Dipper across the month: a bowl in the last weeks, the handle
// climbing to Polaris in the top-right day
const BOWL = [[1, 4], [2, 4], [2, 3], [1, 3]];
const HANDLE = [[2, 3], [3, 2], [4, 2], [5, 1]];
const POLARIS = [6, 0];
const lines = (stroke, w, op = 0.9) => {
  const pts = (xs) => xs.map(([c, r]) => `${cell(c, r).cx.toFixed(1)},${cell(c, r).cy.toFixed(1)}`).join(" ");
  return `<polyline points="${pts([...BOWL, BOWL[0]])}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" opacity="${op}"/>
    <polyline points="${pts([...HANDLE, POLARIS])}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" opacity="${op}"/>`;
};
const onPath = new Set([...BOWL, ...HANDLE].map(([c, r]) => `${c},${r}`));
const cells = (fill, litFill, { skipPolaris = true, rx = 12, dots = false } = {}) =>
  [...Array(cols).keys()].flatMap((c) => [...Array(rows).keys()].map((r) => {
    if (skipPolaris && c === POLARIS[0] && r === POLARIS[1]) return "";
    const k = cell(c, r); const lit = onPath.has(`${c},${r}`);
    if (dots) return `<circle cx="${k.cx}" cy="${k.cy}" r="${lit ? 18 : 9}" fill="${lit ? litFill : fill}"/>`;
    return `<rect x="${k.x + 7}" y="${k.y + 6}" width="${cw - 14}" height="${ch - 12}" rx="${rx}" fill="${lit ? litFill : fill}"/>`;
  })).join("");
const rings = (fill) => `<rect x="${P.x + 128}" y="${P.y - 50}" width="34" height="96" rx="17" fill="${fill}"/><rect x="${P.x + P.w - 162}" y="${P.y - 50}" width="34" height="96" rx="17" fill="${fill}"/>`;
const page = (body, head) => `<g filter="url(#shadow)"><rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="60" fill="${body}"/>
  <path d="M${P.x} ${P.y + 60} a60 60 0 0 1 60 -60 h${P.w - 120} a60 60 0 0 1 60 60 v${P.head - 60} h-${P.w}z" fill="${head}"/></g>`;
const polaris = (R = 70, glow = 130, dx = 0, dy = 0) => {
  const k = cell(...POLARIS);
  return `<circle cx="${k.cx + dx}" cy="${k.cy + dy}" r="${glow}" fill="url(#glow)"/><path d="${star(k.cx + dx, k.cy + dy, R, { north: R * 1.25, south: R * 0.92, side: R * 0.76 })}" fill="url(#gold)" stroke="#b9800f" stroke-width="3"/>`;
};

const icons = {
  C: { name: "C · original", svg: readFileSync("design/icon-ideas/C.svg", "utf8").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "") },
  C1: { name: "Dipper on the month", note: "cream page, red header, the constellation lights up days", svg: `${defs}${tile("url(#night)")}${page("#f6f2e9", "#e5484d")}${rings("#c9cfdb")}
    ${cells("#ddd6c9", "#f3d27a")}${lines("#c98f12", 9)}${polaris(64, 120)}` },
  C2: { name: "Night month", note: "the whole page at night; Polaris breaks out of its corner", svg: `${defs}${tile("url(#night)")}${page("#17234a", "#2a3a6c")}${rings("#8fa3d6")}
    ${cells("#25335f", "#3e4f86")}${lines("#e8b33a", 10)}
    ${[...BOWL, ...HANDLE].map(([c, r]) => `<circle cx="${cell(c, r).cx}" cy="${cell(c, r).cy}" r="15" fill="#ffe08a"/>`).join("")}${polaris(86, 170, 26, -34)}` },
  C3: { name: "Polaris is today", note: "the red 'today' square of a calendar, crowned with the star", svg: `${defs}${tile("url(#night)")}${page("#f6f2e9", "#1f2d57")}${rings("#e2a41f")}
    ${cells("#ddd6c9", "#e9dcbc", { skipPolaris: false })}${lines("#c98f12", 8, 0.8)}
    ${(() => { const k = cell(...POLARIS); return `<rect x="${k.x + 7}" y="${k.y + 6}" width="${cw - 14}" height="${ch - 12}" rx="12" fill="#e5484d"/>`; })()}
    ${polaris(46, 92, 0, -2)}` },
  C4: { name: "Constellation month (dots)", note: "C's dot grid, framed as a month page with header and rings", svg: `${defs}${tile("url(#night)")}
    <rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="60" fill="none" stroke="#5a6ea8" stroke-width="10"/>
    <path d="M${P.x} ${P.y + P.head} h${P.w}" stroke="#5a6ea8" stroke-width="10"/>${rings("#8fa3d6")}
    ${cells("#4a5d96", "#ffe08a", { dots: true })}${lines("#e8b33a", 10)}${polaris(78, 150, 18, -26)}` },
  C5: { name: "Daylight month", note: "light tile for light docks: navy header, gold rings", svg: `${defs}${tile("url(#cream)")}
    <rect x="100" y="100" width="824" height="824" rx="186" fill="none" stroke="#e3dccd" stroke-width="4"/>${page("#ffffff", "#1d2b57")}${rings("#e2a41f")}
    ${cells("#ece6da", "#c9d3f0")}${lines("#1d2b57", 9, 0.85)}
    ${[...BOWL, ...HANDLE].map(([c, r]) => `<circle cx="${cell(c, r).cx}" cy="${cell(c, r).cy}" r="12" fill="#1d2b57"/>`).join("")}${polaris(66, 120)}` },
};
const svgDoc = (inner, size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">${inner}</svg>`;
for (const [k, v] of Object.entries(icons)) if (k !== "C") writeFileSync(`design/icon-ideas/${k}.svg`, svgDoc(v.svg, 1024));
const cards = Object.entries(icons).map(([k, v]) => `
  <div class="card${k === "C" ? " ref" : ""}"><div class="big">${svgDoc(v.svg, 300)}</div>
  <div class="small">${svgDoc(v.svg, 64)}${svgDoc(v.svg, 32)}<span class="dock">Dock · menu</span></div>
  <div class="name"><b>${k}</b> ${v.name.replace(/^C · /, "")}</div>${v.note ? `<div class="note">${v.note}</div>` : ""}</div>`).join("");
writeFileSync("design/icon-ideas/sheet2.html", `<!doctype html><body style="margin:0;background:#f4f3ef;font:15px -apple-system,sans-serif;color:#2b2b2b">
<style>.grid{display:grid;grid-template-columns:repeat(3,340px);gap:18px;padding:24px}.card{background:#fff;border-radius:16px;padding:16px 18px 14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.ref{opacity:.75}
.big{display:flex;justify-content:center}.small{display:flex;align-items:center;gap:12px;margin:8px 0 4px 8px}.dock{color:#999;font-size:12px}.name{margin-left:8px}.note{margin:3px 0 0 8px;color:#777;font-size:13px}</style>
<div class="grid" id="g">${cards}</div></body>`);
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1140, height: 900 }, deviceScaleFactor: 2 })).newPage();
await pg.goto(`file://${process.cwd()}/design/icon-ideas/sheet2.html`);
await pg.locator("#g").screenshot({ path: "design/icon-ideas/north-star-icon-C-variations.png" });
await b.close();
console.log("ok");
