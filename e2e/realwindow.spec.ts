// The text / layout laws in the REAL app window (WKWebView), on real data.
// Needs the sandboxed debug app (`e2e/sandbox_app.sh start`): a snapshot of
// the calendar DB with Google sync off, so nothing here touches live data.
// Drives it through the debug test hook (:14211, async eval) and the WebDriver
// plugin (:4445, window size + screenshots); skips when they aren't up.
// Window screenshots land in test-results/realwindow/.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { probeInPage, type ProbeResult } from "./textprobe";

// one real window: the views must run one after another
test.describe.configure({ mode: "serial" });

const HOOK = "http://127.0.0.1:14211";
const WD = "http://127.0.0.1:4445";
const OUT = process.env.REALWINDOW_DIR ?? "test-results/realwindow";

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function evalJs<T = unknown>(script: string): Promise<T> {
  const r = await post(HOOK, { cmd: "eval", script });
  if (!r.ok) throw new Error(r.error);
  return r.result as T;
}
async function up() {
  try {
    const s = await (await fetch(`${WD}/status`)).json();
    return !!s.value?.ready && (await evalJs<boolean>("return true")) === true;
  } catch {
    return false;
  }
}
const key = (k: string, mods = "") =>
  evalJs(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, ` +
      `metaKey: ${mods.includes("m")}, shiftKey: ${mods.includes("s")} })); return true`,
  );

async function runProbe(): Promise<ProbeResult> {
  await evalJs(
    `window.__tp = undefined; (${probeInPage.toString()})().then((r) => (window.__tp = r), ` +
      `(e) => (window.__tp = { error: String((e && e.stack) || e) })); return true`,
  );
  for (let i = 0; i < 240; i++) {
    const r = await evalJs<(ProbeResult & { error?: string }) | null>("return window.__tp ?? null");
    if (r) {
      if (r.error) throw new Error(r.error);
      return r;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("probe did not finish in the real window");
}

const VIEWS: { name: string; width: number; keys: [string, string][] }[] = [
  { name: "week", width: 1280, keys: [] },
  { name: "week zoomed out", width: 1280, keys: [[",", "ms"], [",", "ms"]] },
  { name: "week zoomed in", width: 1280, keys: [[".", "ms"], [".", "ms"], [".", "ms"]] },
  { name: "week narrow", width: 900, keys: [] },
  { name: "9 days", width: 1280, keys: [["9", ""]] },
  { name: "small window", width: 640, keys: [] },
  { name: "small window, 9 days", width: 640, keys: [["9", ""]] },
];

for (const v of VIEWS) {
  test(`REAL WINDOW TEXT (${v.name}): every title, time and note whole, uncovered and aligned`, async () => {
    test.skip(!(await up()), "sandboxed debug app not running (e2e/sandbox_app.sh start)");
    test.setTimeout(180_000);
    const sid = (await post(`${WD}/session`, { capabilities: { alwaysMatch: {} } })).value.sessionId;
    try {
      // the plugin sizes windows in device pixels: correct by the viewport
      // the page actually gets (a Retina display halves it)
      await post(`${WD}/session/${sid}/window/rect`, { width: v.width, height: 900 });
      await new Promise((res) => setTimeout(res, 300));
      const iw = await evalJs<number>("return innerWidth");
      if (Math.abs(iw - v.width) > 2) {
        const k = v.width / iw;
        await post(`${WD}/session/${sid}/window/rect`, { width: Math.round(v.width * k), height: Math.round(900 * k) });
      }
      await evalJs(`document.querySelector("[data-testid=sweep-banner] .toast-close")?.click(); return true`);
      await key("w");
      await key("0", "ms");
      for (const [k, m] of v.keys) await key(k, m);
      // the window resize and view change settle asynchronously: probe only
      // once the column geometry reads the same twice in a row
      let last = "";
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 250));
        const now = await evalJs<string>(
          `return innerWidth + "|" + [...document.querySelectorAll("[data-testid^=day-col-]")]` +
            `.map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.width].map(Math.round).join(","); }).join(";") + ` +
            `"|" + document.querySelectorAll(".pan-settle").length`,
        );
        if (now === last && now.endsWith("|0")) break;
        last = now;
      }
      const r = await runProbe();
      // a look at the morning-to-evening span, for review by eye
      await evalJs(`const g = document.querySelector("[data-testid=week-grid]"); g.scrollTop = g.scrollHeight * 0.3; return true`);
      await new Promise((res) => setTimeout(res, 300));
      const shot = await (await fetch(`${WD}/session/${sid}/screenshot`)).json();
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/${v.name.replace(/\s+/g, "-")}.png`, Buffer.from(shot.value, "base64"));
      console.log(
        `[real window / ${v.name}] events=${r.events} noTime=${r.noTime.length} cut=${r.cut.length} notes=${r.noteCount}` +
          (r.cut.length ? `\n  cut: ${r.cut.join("\n  cut: ")}` : ""),
      );
      expect(r.text, "text covered or sticking out of its event").toEqual([]);
      expect(r.blank, "blank space inside overlapping events").toEqual([]);
      expect(r.align, "text block not aligned").toEqual([]);
      expect(r.notes, "margin notes cut, on text or on each other, or not tied to their event").toEqual([]);
    } finally {
      await key("0", "ms");
      await key("w");
      await fetch(`${WD}/session/${sid}`, { method: "DELETE" });
    }
  });
}
