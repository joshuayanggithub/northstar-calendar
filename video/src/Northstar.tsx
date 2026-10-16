import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { Shot } from "./Shot";

// 10 s: five shots of the demo week (scripts/readme in the app repo), each
// crossfading into the next
export const Northstar: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "#191919" }}>
      <TransitionSeries>
        <TransitionSeries.Sequence name="The week" durationInFrames={70} premountFor={fps}>
          <Shot
            src="week.png"
            kicker="northstar"
            caption="A calendar aimed at your long-term goals"
            focus="50% 50%"
            zoom={1.06}
            captionTop={false}
            premountFor={fps}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 12 })} />
        <TransitionSeries.Sequence name="Reconcile" durationInFrames={70} premountFor={fps}>
          <Shot
            src="reconcile.png"
            kicker="Reconcile"
            caption="Confirm what actually happened"
            focus="100% 85%"
            zoom={1.025}
            captionTop
            premountFor={fps}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 12 })} />
        <TransitionSeries.Sequence name="Annotations" durationInFrames={70} premountFor={fps}>
          <Shot
            src="annotations.png"
            kicker="Annotations"
            caption="Self-reflection, in the margins"
            focus="30% 72%"
            zoom={1.22}
            captionTop={false}
            premountFor={fps}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 12 })} />
        <TransitionSeries.Sequence name="Focus and goals" durationInFrames={70} premountFor={fps}>
          <Shot
            src="focus.png"
            kicker="Focus score · goals"
            caption="See how the day really went"
            focus="38% 22%"
            zoom={1.3}
            captionTop={false}
            premountFor={fps}
          />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 12 })} />
        <TransitionSeries.Sequence name="Overlaps" durationInFrames={70} premountFor={fps}>
          <Shot
            src="compare.png"
            kicker="Overlapping events"
            caption="Readable where other calendars give up"
            focus="50% 32%"
            zoom={1.03}
            captionTop={false}
            premountFor={fps}
          />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
