// The app icon: design/icon/north-star.svg ("Polaris is today": a month
// page where the Little Dipper runs across the days to the red today square,
// crowned by the north star) and the menu bar's template glyph, tray.svg.
// Concepts and variations: design/icon-ideas/.
//   PLAYWRIGHT_BROWSERS_PATH=0 node design/icon/export.mjs
//   npm run tauri icon -- design/icon/north-star-1024.png   (every app icon size)
// Writes design/icon/north-star-1024.png and src-tauri/icons/tray-template.png.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const b = await chromium.launch();
const shoot = async (file, size, out) => {
  const svg = readFileSync(file, "utf8").replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  const page = await (await b.newContext({ viewport: { width: size, height: size } })).newPage();
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${svg}</body>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.context().close();
};
await shoot("design/icon/north-star.svg", 1024, "design/icon/north-star-1024.png");
await shoot("design/icon/tray.svg", 36, "src-tauri/icons/tray-template.png");
await b.close();
