import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
const star = (cx, cy, R, { north = R, south = R, side = R * 0.78, waist = 0.16 } = {}) => {
  const c = R * waist;
  return `M ${cx} ${cy - north} Q ${cx + c} ${cy - c} ${cx + side} ${cy} Q ${cx + c} ${cy + c} ${cx} ${cy + south} Q ${cx - c} ${cy + c} ${cx - side} ${cy} Q ${cx - c} ${cy - c} ${cx} ${cy - north} Z`;
};
const defs = `<defs>
  <linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1630"/><stop offset="1" stop-color="#1f2d57"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe490"/><stop offset="1" stop-color="#e6a51c"/></linearGradient>
  <linearGradient id="red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f05a5f"/><stop offset="1" stop-color="#d8393f"/></linearGradient>
  <radialGradient id="halo"><stop offset="0" stop-color="#fff6d8" stop-opacity=".95"/><stop offset=".55" stop-color="#ffe9a6" stop-opacity=".45"/><stop offset="1" stop-color="#ffe9a6" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000" flood-opacity=".3"/></filter>
  <filter id="starShadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#7a4a00" flood-opacity=".45"/></filter>
</defs>`;
const tile = `<rect x="100" y="100" width="824" height="824" rx="186" fill="url(#night)"/>`;
const variant = ({ cols = 7, rows = 5, line = 8, R = 46, cellR = 12, todayPad = 7, halo = 0, lit = "#e9dcbc", lineOp = 0.8, dots = 0, starStroke = 3, sy = -0.25, starFill = "url(#gold)", stroke = "#a86f05", shadow = true }) => {
  const P = { x: 204, y: 268, w: 616, h: 540, head: 112 };
  const padX = 36, padY = 30;
  const cw = (P.w - 2 * padX) / cols, ch = (P.h - P.head - 2 * padY) / rows;
  const cell = (c, r) => ({ x: P.x + padX + c * cw, y: P.y + P.head + padY + r * ch, cx: P.x + padX + c * cw + cw / 2, cy: P.y + P.head + padY + r * ch + ch / 2 });
  const last = cols - 1;
  const BOWL = [[1, rows - 1], [2, rows - 1], [2, rows - 2], [1, rows - 2]];
  const HANDLE = [[2, rows - 2], [3, rows - 3], [4, rows - 3], [5, 1]];
  const POL = [last, 0];
  const on = new Set([...BOWL, ...HANDLE].map(([c, r]) => `${c},${r}`));
  const pts = (xs) => xs.map(([c, r]) => `${cell(c, r).cx.toFixed(1)},${cell(c, r).cy.toFixed(1)}`).join(" ");
  const k = cell(...POL);
  return `${defs}${tile}
  <g filter="url(#shadow)"><rect x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="60" fill="#f6f2e9"/>
  <path d="M${P.x} ${P.y + 60} a60 60 0 0 1 60 -60 h${P.w - 120} a60 60 0 0 1 60 60 v${P.head - 60} h-${P.w}z" fill="#1f2d57"/></g>
  <rect x="${P.x + 128}" y="${P.y - 50}" width="34" height="96" rx="17" fill="#e6a51c"/><rect x="${P.x + P.w - 162}" y="${P.y - 50}" width="34" height="96" rx="17" fill="#e6a51c"/>
  ${[...Array(cols).keys()].flatMap((c) => [...Array(rows).keys()].map((r) => (c === POL[0] && r === POL[1]) ? "" :
      `<rect x="${cell(c, r).x + 7}" y="${cell(c, r).y + 6}" width="${cw - 14}" height="${ch - 12}" rx="${cellR}" fill="${on.has(`${c},${r}`) ? lit : "#ddd6c9"}"/>`)).join("")}
  <polyline points="${pts([...BOWL, BOWL[0]])}" fill="none" stroke="#c98f12" stroke-width="${line}" stroke-linejoin="round" opacity="${lineOp}"/>
  <polyline points="${pts([...HANDLE, POL])}" fill="none" stroke="#c98f12" stroke-width="${line}" stroke-linejoin="round" stroke-linecap="round" opacity="${lineOp}"/>
  ${dots ? [...BOWL, ...HANDLE].map(([c, r]) => `<circle cx="${cell(c, r).cx}" cy="${cell(c, r).cy}" r="${dots}" fill="#c98f12"/>`).join("") : ""}
  <rect x="${k.x + todayPad}" y="${k.y + todayPad - 1}" width="${cw - 2 * todayPad}" height="${ch - 2 * todayPad + 2}" rx="${cellR + 2}" fill="url(#red)"/>
  ${halo ? `<circle cx="${k.cx}" cy="${k.cy + R * sy}" r="${halo}" fill="url(#halo)"/>` : ""}
  <path d="${star(k.cx, k.cy + R * sy, R, { north: R * 1.3, south: R * 0.9, side: R * 0.76 })}" fill="${starFill}" stroke="${stroke}" stroke-width="${starStroke}" ${shadow ? 'filter="url(#starShadow)"' : ""}/>`;
};
const icons = {
  "C3d": { name: "star crowning a bigger today", svg: variant({ R: 58, sy: -0.95, todayPad: -2, line: 11, lineOp: 0.9, dots: 12, starStroke: 4, halo: 0 }) },
  "C3e": { name: "star set in today", svg: variant({ R: 34, sy: 0.12, todayPad: -2, line: 11, lineOp: 0.9, dots: 12, starFill: "#fff3c4", stroke: "#fff3c4", starStroke: 2, shadow: false }) },
  "C3": { name: "as picked", svg: readFileSync("design/icon-ideas/C3.svg", "utf8").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "") },
  "C3a": { name: "bigger star crowning today", svg: variant({ R: 84, halo: 120, line: 11, lineOp: 0.9, dots: 13, todayPad: 4 }) },
};
const svgDoc = (inner, size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">${inner}</svg>`;
for (const [k, v] of Object.entries(icons)) if (k !== "C3") writeFileSync(`design/icon-ideas/${k}.svg`, svgDoc(v.svg, 1024));
const cards = Object.entries(icons).map(([k, v]) => `<div class="card"><div class="big">${svgDoc(v.svg, 260)}</div>
  <div class="small">${svgDoc(v.svg, 128)}${svgDoc(v.svg, 64)}${svgDoc(v.svg, 32)}${svgDoc(v.svg, 16)}</div><div class="name"><b>${k}</b> ${v.name}</div></div>`).join("");
writeFileSync("design/icon-ideas/sheet3.html", `<!doctype html><body style="margin:0;background:#f4f3ef;font:15px -apple-system,sans-serif;color:#2b2b2b">
<style>.grid{display:grid;grid-template-columns:repeat(4,300px);gap:16px;padding:22px}.card{background:#fff;border-radius:16px;padding:14px 16px 12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.big{display:flex;justify-content:center}.small{display:flex;align-items:center;gap:10px;margin:8px 0 4px 4px}.name{margin-left:6px}</style><div class="grid" id="g">${cards}</div>
<div id="dock" style="display:flex;gap:14px;align-items:center;margin:0 22px 22px;padding:10px 18px;background:#e7e5df;border-radius:18px;width:fit-content">${Object.values(icons).map((v) => svgDoc(v.svg, 54)).join("")}<span style="color:#888;font-size:13px">in a Dock</span></div></body>`);
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1320, height: 700 }, deviceScaleFactor: 2 })).newPage();
await pg.goto(`file://${process.cwd()}/design/icon-ideas/sheet3.html`);
await pg.screenshot({ path: "design/icon-ideas/c3-refine2.png", fullPage: true });
await b.close();
console.log("ok");
