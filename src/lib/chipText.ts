// Text measurement for event labels (canvas, in the app's chip fonts), and
// the label band an event asks the layout for. Where each piece of text goes
// inside an event's visible shape is lib/labelPlace.ts.

import { fmtChipRange, fmtTimeShort } from "./dates";

/** row heights (px), matching app.css */
const TITLE_LH = 15;
const TIME_LH = 13;
const PAD_Y = 4;
/** one row: title line + padding — the smallest label band */
const LINE_BAND_PX = TITLE_LH + 2;
const SLACK = 2; // measurement vs layout rounding

let ctx: CanvasRenderingContext2D | null | undefined;
let family = "";
const widths = new Map<string, number>();

/** rendered width of text in the app font; a rough estimate without a DOM */
export function textPx(text: string, sizePx: number, weight = 500): number {
  const key = `${weight}|${sizePx}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    family = typeof document === "undefined" ? "" : getComputedStyle(document.body).fontFamily;
  }
  let w: number;
  if (ctx) {
    ctx.font = `${weight} ${sizePx}px ${family}`;
    w = ctx.measureText(text).width;
  } else {
    w = text.length * sizePx * 0.56;
  }
  widths.set(key, w);
  return w;
}

/** greedy word wrap, breaking where the browser does: at spaces, after
 *  hyphens and dashes, after slashes (titles render a <wbr> there), and
 *  mid-word only when one piece can't fit (CSS break-word). How many lines the text takes at this width; with tailPx,
 *  an unbreakable tail (e.g. " 9 AM") follows the last word. */
export function wrapLines(text: string, sizePx: number, widthPx: number, weight = 500, tailPx = 0): number {
  if (widthPx <= 0) return 1;
  const words = text.split(/\s+/).filter(Boolean);
  const space = textPx(" ", sizePx, weight);
  let lines = 1;
  let cur = 0;
  for (const word of words) {
    word.split(/(?<=[-\u2010-\u2014/])/).forEach((part, k) => {
      let pw = textPx(part, sizePx, weight);
      const sep = k === 0 ? space : 0;
      if (cur > 0 && cur + sep + pw <= widthPx) {
        cur += sep + pw;
        return;
      }
      if (cur > 0) lines++;
      while (pw > widthPx) {
        lines++;
        pw -= widthPx;
      }
      cur = pw;
    });
  }
  if (tailPx > 0 && cur + tailPx > widthPx) return tailPx > widthPx ? Infinity : lines + 1;
  return lines;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** start time without the meridiem — position in the grid already says it */
function bareTime(d: Date) {
  return `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())}`;
}

export interface TextSizes {
  title: number;
  inlineTime: number;
  time: number;
}
export const SIZES: TextSizes = { title: 11, inlineTime: 10.5, time: 10 };
export const SIZES_XS: TextSizes = { title: 9.5, inlineTime: 9, time: 9 };

/** Label band (px) an event asks the layout for when its text block didn't
 *  fit: room for the WHOLE title (up to maxLines) plus the time, either
 *  right after the title's last word or on its own row, whichever is
 *  shorter. */
export function blockBandPx(
  title: string,
  start: Date,
  end: Date,
  contentPx: number,
  bold = false,
  maxLines = 3,
): number {
  if (contentPx <= 0) return LINE_BAND_PX;
  const wt = bold ? 600 : 500;
  const need = Math.min(maxLines, wrapLines(title, SIZES.title, contentPx, wt));
  const stack = timeRow(start, end, contentPx) ? PAD_Y + need * TITLE_LH + TIME_LH : PAD_Y + need * TITLE_LH;
  const tail = textPx(" ", SIZES.title) + textPx(fmtTimeShort(start), SIZES.inlineTime) + 1;
  const trailLines = wrapLines(title, SIZES.title, contentPx, wt, tail);
  const trail = trailLines <= maxLines ? PAD_Y + trailLines * TITLE_LH : Infinity;
  return Math.min(stack, trail);
}

/** the time row of a stacked label: the range, else the start, else null */
function timeRow(start: Date, end: Date, contentPx: number, sizes: TextSizes = SIZES): string | null {
  for (const t of [fmtChipRange(start, end), fmtTimeShort(start), bareTime(start)]) {
    if (textPx(t, sizes.time, 400) <= contentPx - SLACK) return t;
  }
  return null;
}
