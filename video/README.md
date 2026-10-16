# northstar video

The 10-second demo at the top of the app's README: a real session in the app
on a made-up week, recorded frame by frame, then cut (camera, labels,
captions) with [Remotion](https://www.remotion.dev/) and its agent skills
(`npx skills add remotion-dev/skills --agent claude-code --skill '*' --yes`).

```bash
npm i
npm run record    # the session: ../scripts/readme/record.mjs (needs the app's dev server on :1420)
npm run dev       # Remotion Studio
npm run render    # ../docs/media/northstar.mp4 (1080p) + .gif (the gif needs ffmpeg on PATH)
```
