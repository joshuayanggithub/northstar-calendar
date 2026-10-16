import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/Newsreader";
import type React from "react";
import {
  AbsoluteFill,
  CanvasImage,
  Easing,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import timeline from "./timeline.json";

// A real session in the app on a made-up week, recorded frame by frame by
// ../scripts/readme/record.mjs (frames in public/rec, marks + feature
// positions in timeline.json). This cut adds the camera, labels, captions.

const { fontFamily: serif } = loadSerif("normal", { weights: ["500"], subsets: ["latin"] });
const { fontFamily: mono } = loadMono("normal", { weights: ["500"], subsets: ["latin"] });

const M = timeline.marks;
const S = timeline.spots;
const ease = Easing.bezier(0.45, 0, 0.2, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const mid = (r: { x0: number; y0: number; x1: number; y1: number }) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/** a camera shot from frame `at`: zoom `s`, centered on x, y (fractions of the frame) */
type Shot = { at: number; s: number; x?: number; y?: number };
const fact = mid(S.fact);
const SHOTS: Shot[] = [
  { at: 0, s: 1 },
  { at: M.reconcile, s: 1.8, ...fact }, // hover: ✓ and ✕
  { at: M.review, s: 1.2, x: 0.5, y: 0.58 }, // the review pill and all of Wednesday
  { at: M.notes, s: 1.55, x: 0.443, y: 0.42 }, // the model's notes (the caption over the time gutter)
  { at: M.addnote, s: 1.75, x: 0.74, y: 0.29 }, // the event and its panel
  { at: M.noted, s: 2.2, x: 0.6, y: 0.53 }, // the new note, then the drag
  { at: M.plan, s: 1 }, // Saturday and the form, all of it
  { at: M.planned, s: 2.3, ...mid(S.block) }, // rabbet joint, C-shape
  { at: M.cluster, s: 1 },
  { at: M.clustered, s: 2.3, ...mid(S.cluster) },
  { at: M.outro, s: 1 },
];
const MOVE = 24; // frames a camera move takes

const keys = (() => {
  const at: number[] = [];
  const v: { s: number; x: number; y: number }[] = [];
  const val = (sh: Shot) => ({ s: sh.s, x: sh.x ?? 0.5, y: sh.y ?? 0.5 });
  SHOTS.forEach((sh, i) => {
    if (i === 0) {
      at.push(0);
      v.push(val(sh));
      return;
    }
    const start = Math.max(sh.at, at[at.length - 1] + 1);
    at.push(start, start + MOVE);
    v.push(v[v.length - 1], val(sh));
  });
  return { at, v };
})();

function camera(frame: number) {
  const k = (pick: (o: (typeof keys.v)[number]) => number) =>
    interpolate(frame, keys.at, keys.v.map(pick), { ...clamp, easing: ease });
  const s = k((o) => o.s);
  // never past the edge of the recording
  const half = 0.5 / s;
  const x = Math.min(1 - half, Math.max(half, k((o) => o.x)));
  const y = Math.min(1 - half, Math.max(half, k((o) => o.y)));
  return { s, x, y };
}

/** a label in the frame's own coordinates, pointing left-to-right at x, y */
const Label: React.FC<{ name: string; text: string; x: number; y: number; from: number; to: number }> = ({
  name,
  text,
  x,
  y,
  from,
  to,
}) => {
  const frame = useCurrentFrame();
  return (
    <Interactive.Div
      name={name}
      style={{
        position: "absolute",
        right: pct(1 - x),
        top: pct(y),
        translate: "0 -50%",
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontFamily: mono,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.4,
        color: "#f4d26b",
        whiteSpace: "nowrap",
        textShadow: "0 0 3px #111, 0 0 3px #111",
        opacity: interpolate(frame, [from, from + 8, to - 4, to], [0, 1, 1, 0], clamp),
      }}
    >
      {text}
      <span
        style={{
          display: "block",
          height: 1.5,
          background: "#f4d26b",
          width: interpolate(frame, [from, from + 10], [0, 22], { ...clamp, easing: ease }),
        }}
      />
    </Interactive.Div>
  );
};

type Caption = { from: number; to: number; kicker: string; text: string; hints?: [number, string][] };
const CAPTIONS: Caption[] = [
  { from: 0, to: M.reconcile, kicker: "northstar", text: "A calendar built around your goals" },
  {
    from: M.reconcile,
    to: M.notes,
    kicker: "1 · Reconcile",
    text: "Confirm what actually happened",
    hints: [
      [M.reconcile, "Dotted means unconfirmed: ✓ or ✕"],
      [M.review, "Or review yesterday, one event at a time"],
    ],
  },
  {
    from: M.notes,
    to: M.plan,
    kicker: "2 · Annotations",
    text: "Reflect in the margins",
    hints: [
      [M.notes, "Notes on how the week went"],
      [M.addnote, "Add one to any event"],
      [M.dragnote, "Drag it anywhere; the arrow follows"],
    ],
  },
  {
    from: M.plan,
    to: M.cluster,
    kicker: "3 · Plan a day",
    text: "Overlaps keep every title readable",
    hints: [[M.plan, "A call, then a writing block over it"]],
  },
  { from: M.cluster, to: M.outro, kicker: "4 · Quick tasks", text: "Short overlapping tasks become one list" },
  { from: M.outro, to: M.end + 1, kicker: "northstar", text: "A calendar built around your goals" },
];

const CaptionCard: React.FC<{ c: Caption }> = ({ c }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hints = c.hints ?? [];
  return (
    <Interactive.Div
      name={`Caption: ${c.kicker}`}
      style={{
        position: "absolute",
        left: 48,
        top: 40,
        padding: "14px 22px 16px",
        borderRadius: 14,
        background: "rgba(14,14,14,0.86)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "#f4f4f2",
        opacity: interpolate(frame, [c.from, c.from + 0.25 * fps, c.to - 0.2 * fps, c.to], [0, 1, 1, 0], clamp),
        translate: interpolate(frame, [c.from, c.from + 0.3 * fps], ["0px 10px", "0px 0px"], { ...clamp, easing: ease }),
      }}
    >
      <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 500, letterSpacing: 2.2, color: "#e2b93b", textTransform: "uppercase" }}>
        {c.kicker}
      </div>
      <div style={{ fontFamily: serif, fontSize: 42, fontWeight: 500, lineHeight: 1.1, marginTop: 4, letterSpacing: -0.4 }}>{c.text}</div>
      {hints.length > 0 && (
        // every hint in the same cell, so the card keeps one size
        <div style={{ display: "grid", marginTop: 8 }}>
          {hints.map(([at, text], i) => {
            const next = hints[i + 1]?.[0] ?? c.to;
            return (
              <div
                key={text}
                style={{
                  gridArea: "1 / 1",
                  fontFamily: mono,
                  fontSize: 17,
                  fontWeight: 500,
                  color: "#c9c9c2",
                  opacity: interpolate(frame, [at, at + 8, next - 6, next], [0, 1, 1, 0], clamp),
                }}
              >
                {text}
              </div>
            );
          })}
        </div>
      )}
    </Interactive.Div>
  );
};

export const Demo: React.FC = () => {
  const frame = useCurrentFrame();
  const cam = camera(frame);
  return (
    <AbsoluteFill style={{ backgroundColor: "#191919" }}>
      <AbsoluteFill
        style={{
          transformOrigin: "0 0",
          transform: `translate(${pct(0.5 - cam.x * cam.s)}, ${pct(0.5 - cam.y * cam.s)}) scale(${cam.s})`,
        }}
      >
        <CanvasImage
          name="Recording"
          src={staticFile(`rec/${String(Math.min(frame, timeline.frames - 1)).padStart(4, "0")}.jpg`)}
          fit="cover"
          style={{ position: "absolute", width: "100%", height: "100%" }}
        />
        <Label name="Rabbet label" text="rabbet joint" x={S.block.x0 - 0.004} y={S.swim.y1 - 0.004} from={M.planned + 14} to={M.cluster} />
        <Label name="C-shape label" text="C-shape" x={S.block.x0 - 0.004} y={(S.call.y0 + S.call.y1) / 2 + 0.02} from={M.planned + 20} to={M.cluster} />
        <Label name="Cluster label" text="clustered view" x={S.cluster.x0 - 0.004} y={(S.cluster.y0 + S.cluster.y1) / 2} from={M.clustered + 14} to={M.outro} />
      </AbsoluteFill>
      {CAPTIONS.map((c) => (
        <CaptionCard key={`${c.kicker}-${c.from}`} c={c} />
      ))}
    </AbsoluteFill>
  );
};
