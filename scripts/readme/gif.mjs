// The README's walkthrough GIF, made from the rendered video
// (docs/media/northstar.mp4) in the same frame as every README screenshot
// (scripts/readme/shots.mjs): the same padding, rounded corners and hairline
// border and soft shadow, in proportion at the README's 800px. Opaque, on
// GitHub's white page: a GIF with transparency can't skip the pixels that
// didn't change between frames and comes out four times the size (51 MB).
//   PLAYWRIGHT_BROWSERS_PATH=0 node scripts/readme/gif.mjs   (or: cd video && npm run gif)
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve("docs/media/northstar.mp4");
const OUT = resolve("docs/media/northstar.gif");
const TMP = resolve("docs/media/.gif-frame");
// the screenshots: a 1000px-wide app window, 28px of padding, a 10px radius
const W = 960;
const k = W / (1000 + 2 * 28);
const PAD = Math.round(28 * k);
const CW = W - 2 * PAD;
const CH = Math.round((CW * 9) / 16);
const H = CH + 2 * PAD;
const R = Math.round(10 * k);

mkdirSync(TMP, { recursive: true });
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const draw = async (file, inner) => {
  await page.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;width:${W}px;height:${H}px;background:transparent}
    .c{position:absolute;left:${PAD}px;top:${PAD}px;width:${CW}px;height:${CH}px;box-sizing:border-box;border-radius:${R}px;${inner}}
  </style></head><body><div class="c"></div></body></html>`);
  await page.screenshot({ path: file, omitBackground: true });
};
// where the card is (white) and isn't (black), its hairline, and the page
// under it with the card's shadow
await page.setContent("");
await draw(`${TMP}/mask.png`, "background:#fff;box-shadow:0 0 0 2000px #000");
await draw(`${TMP}/border.png`, "border:1px solid rgba(0,0,0,.1)");
await page.setViewportSize({ width: W, height: H });
await page.setContent(`<!doctype html><html><head><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#fff}
  .c{position:absolute;left:${PAD}px;top:${PAD}px;width:${CW}px;height:${CH}px;border-radius:${R}px;background:#fff;
    box-shadow:0 ${6 * k}px ${16 * k}px rgba(0,0,0,.12),0 ${1 * k}px ${3 * k}px rgba(0,0,0,.08)}
</style></head><body><div class="c"></div></body></html>`);
await page.screenshot({ path: `${TMP}/page.png` });
await b.close();

// the video in its frame (both stills repeat at the GIF's rate and stop with
// the video, or the stream never ends)
const inputs = [
  "-i", SRC,
  "-framerate", "10", "-loop", "1", "-i", `${TMP}/mask.png`,
  "-framerate", "10", "-loop", "1", "-i", `${TMP}/border.png`,
  "-framerate", "10", "-loop", "1", "-i", `${TMP}/page.png`,
];
const framed = [
  `[0:v]fps=10,scale=${CW}:${CH}:flags=lanczos,format=rgba,pad=${W}:${H}:${PAD}:${PAD}:color=0x00000000[v]`,
  `[1:v]format=gray[m]`,
  `[v][m]alphamerge=shortest=1[vm]`,
  `[3:v][vm]overlay=0:0:shortest=1[pv]`,
  `[pv][2:v]overlay=0:0:shortest=1,format=rgb24`,
].join(";");
const ff = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
// two passes, so nothing holds the whole video in memory: the palette, then
// the GIF in it
// (the palette counts whole frames: counting only the changing pixels left
// out the page's pure white, and the margin came out a visible grey)
ff(...inputs, "-filter_complex", `${framed},palettegen=max_colors=128:stats_mode=full`, "-frames:v", "1", `${TMP}/palette.png`);
ff(
  ...inputs,
  "-i", `${TMP}/palette.png`,
  "-filter_complex", `${framed}[f];[f][4:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  `${TMP}/out.gif`,
);
// only a finished GIF replaces the old one
renameSync(`${TMP}/out.gif`, OUT);
rmSync(TMP, { recursive: true, force: true });
console.log(`${OUT}: ${W}x${H}, ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);
