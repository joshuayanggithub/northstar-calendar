# northstar video

The 10-second clip at the top of the app's README, made with
[Remotion](https://www.remotion.dev/) and its agent skills
(`npx skills add remotion-dev/skills --agent claude-code --skill '*' --yes`).

The stills come from the app itself, showing a made-up week
(`../scripts/readme/demo.mjs`, captured by `../scripts/readme/shots.mjs`).

```bash
npm i
npm run dev       # Remotion Studio
npm run render    # ../docs/media/northstar.mp4 + .gif (the gif needs ffmpeg on PATH)
```
