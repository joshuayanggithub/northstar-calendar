import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";
import { loadFont as loadSerif } from "@remotion/google-fonts/Newsreader";
import type React from "react";
import {
  CanvasImage,
  Easing,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  type InteractivitySchema,
} from "remotion";

// an editorial serif for the line, a typewriter mono for the label
const { fontFamily: serif } = loadSerif("normal", { weights: ["500"], subsets: ["latin"] });
const { fontFamily: mono } = loadMono("normal", { weights: ["500"], subsets: ["latin"] });

type ShotProps = {
  /** a screenshot of the demo week, in public/ */
  readonly src: string;
  readonly caption: string;
  /** a small line above the caption */
  readonly kicker: string;
  /** where the camera drifts toward, as a CSS transform-origin */
  readonly focus: string;
  /** how far it drifts in */
  readonly zoom: number;
  /** caption at the top, when the bottom of the shot matters */
  readonly captionTop: boolean;
};

const ShotInner: React.FC<ShotProps> = ({ src, caption, kicker, focus, zoom, captionTop }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <>
      <CanvasImage
        name="Screenshot"
        src={staticFile(src)}
        premountFor={fps}
        fit="cover"
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          transformOrigin: focus,
          scale: interpolate(frame, [0, durationInFrames], [1, zoom], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.33, 0, 0.2, 1),
            output: "perceptual-scale",
          }),
        }}
      />
      <Interactive.Div
        name="Scrim"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          ...(captionTop ? { top: 0 } : { bottom: 0 }),
          height: 420,
          background: `linear-gradient(to ${captionTop ? "bottom" : "top"}, rgba(12,12,12,0.92), rgba(12,12,12,0))`,
        }}
      />
      <Interactive.Div
        name="Caption"
        style={{
          position: "absolute",
          left: 120,
          right: 120,
          ...(captionTop ? { top: 96 } : { bottom: 104 }),
          color: "#f4f4f2",
          opacity: interpolate(frame, [0.15 * fps, 0.55 * fps], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: interpolate(frame, [0.15 * fps, 0.55 * fps], ["0px 28px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
        }}
      >
        <div style={{ fontFamily: mono, fontSize: 34, fontWeight: 500, letterSpacing: 3, color: "#e2b93b", textTransform: "uppercase" }}>
          {kicker}
        </div>
        <div style={{ fontFamily: serif, fontSize: 96, fontWeight: 500, lineHeight: 1.04, letterSpacing: -1, marginTop: 12, textWrap: "balance" }}>
          {caption}
        </div>
      </Interactive.Div>
    </>
  );
};

const shotSchema = {
  src: { type: "asset", default: "week.png", description: "Screenshot" },
  caption: { type: "string", default: "", description: "Caption" },
  kicker: { type: "string", default: "northstar", description: "Kicker" },
  focus: { type: "string", default: "50% 50%", description: "Camera focus (transform-origin)" },
  zoom: { type: "number", default: 1.08, min: 1, max: 2, step: 0.01, description: "Zoom at the end", hiddenFromList: false },
  captionTop: { type: "boolean", default: false, description: "Caption at the top" },
} as const satisfies InteractivitySchema;

export const Shot = Interactive.withSchema({
  Component: ShotInner,
  componentName: "Shot",
  schema: shotSchema,
  wrapInSequence: true,
  layout: "absolute-fill",
});
