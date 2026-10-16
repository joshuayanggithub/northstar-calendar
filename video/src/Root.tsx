import { Composition, Folder } from "remotion";
import { Northstar } from "./Northstar";
import { Shot } from "./Shot";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="Scenes">
        <Composition
          id="Shot"
          component={Shot}
          width={1920}
          height={1200}
          fps={30}
          durationInFrames={70}
          defaultProps={{
            src: "week.png",
            kicker: "northstar",
            caption: "A calendar aimed at your long-term goals",
            focus: "50% 50%",
            zoom: 1.06,
            captionTop: false,
          }}
        />
      </Folder>
      <Composition id="Northstar" component={Northstar} width={1920} height={1200} fps={30} durationInFrames={302} />
    </>
  );
};
