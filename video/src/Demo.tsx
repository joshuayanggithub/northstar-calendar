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
        opacity: interpolate(useCurrentFrame(), [from, from + 6, to - 3, to], [0, 1, 1, 0], clamp),
      }}
    >
      {text}
      <span
        style={{
          display: "block",
          height: 1.5,
          background: "#f4d26b",
          width: interpolate(frame, [from, from + 8], [0, 22], { ...clamp, easing: ease }),
        }}
      />
    </Interactive.Div>
  );
};

const CAPTIONS = [
  { from: 0, to: M.reconcile + 6, kicker: "northstar", text: "A calendar built around your goals" },
  { from: M.reconcile + 6, to: M.plan, kicker: "1 · Reconcile", text: "Confirm what actually happened" },
  { from: M.plan, to: M.cluster, kicker: "2 · Plan a day", text: "Overlaps keep every title readable" },
  { from: M.cluster, to: M.end, kicker: "3 · Quick tasks", text: "Short overlapping tasks become one list" },
];

export const Demo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const close = 2.3;
  // camera: scale and the point it scales about (fractions of the frame)
  const keys = [0, M.reconcile, M.reconcile + 12, M.plan, M.plan + 12, M.planned, M.planned + 10, M.cluster, M.cluster + 10, M.clustered, M.clustered + 10];
  return (
    <AbsoluteFill style={{ backgroundColor: "#191919" }}>
      <AbsoluteFill
        style={{
          scale: interpolate(frame, keys, [1, 1.02, 1.5, 1.5, 1.3, 1.3, close, close, 1.3, 1.3, close], { ...clamp, easing: ease }),
          transformOrigin: `${pct(interpolate(frame, keys, [0.5, 0.5, 0.6, 0.6, 1, 1, 1, 1, 1, 1, 1], { ...clamp, easing: ease }))} ${pct(
            interpolate(frame, keys, [0.5, 0.5, 0.94, 0.94, 0, 0, 0.235, 0.235, 0, 0, 0.64], { ...clamp, easing: ease }),
          )}`,
        }}
      >
        <CanvasImage
          name="Recording"
          src={staticFile(`rec/${String(Math.min(frame, timeline.frames - 1)).padStart(4, "0")}.jpg`)}
          fit="cover"
          style={{ position: "absolute", width: "100%", height: "100%" }}
        />
        <Label name="Rabbet label" text="rabbet joint" x={S.block.x0 - 0.004} y={S.swim.y1 - 0.004} from={M.planned + 6} to={M.cluster + 4} />
        <Label name="C-shape label" text="C-shape" x={S.block.x0 - 0.004} y={(S.call.y0 + S.call.y1) / 2 + 0.02} from={M.planned + 10} to={M.cluster + 4} />
        <Label name="Cluster label" text="clustered view" x={S.cluster.x0 - 0.004} y={(S.cluster.y0 + S.cluster.y1) / 2} from={M.clustered + 6} to={M.end} />
      </AbsoluteFill>
      {CAPTIONS.map((c) => (
        <Interactive.Div
          key={c.kicker}
          name={`Caption: ${c.kicker}`}
          style={{
            position: "absolute",
            left: 56,
            top: 48,
            padding: "18px 26px 20px",
            borderRadius: 16,
            background: "rgba(14,14,14,0.86)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "#f4f4f2",
            opacity: interpolate(frame, [c.from, c.from + 0.25 * fps, c.to - 0.2 * fps, c.to], [0, 1, 1, 0], clamp),
            translate: interpolate(frame, [c.from, c.from + 0.3 * fps], ["0px 10px", "0px 0px"], { ...clamp, easing: ease }),
          }}
        >
          <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 500, letterSpacing: 2.5, color: "#e2b93b", textTransform: "uppercase" }}>
            {c.kicker}
          </div>
          <div style={{ fontFamily: serif, fontSize: 52, fontWeight: 500, lineHeight: 1.08, marginTop: 6, letterSpacing: -0.5 }}>{c.text}</div>
        </Interactive.Div>
      ))}
    </AbsoluteFill>
  );
};
