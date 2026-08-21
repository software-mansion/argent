# static/video

Every file here is served as-is at `/argent/video/<name>.mp4`. Do not commit a
raw screen recording into this directory: run it through the encode pipeline
first, and make sure it has a poster frame.

## Adding a video

1. Keep the source recording OUTSIDE this directory (the script cannot read and
   write the same path). Encode from wherever it was recorded:

   ```bash
   npm run encode:video -- ~/Desktop/my-recording.mov
   ```

   This writes `static/video/my-recording.mp4` (H.264, `+faststart`,
   `yuv420p`, audio stripped) and `static/video/my-recording.jpg`, the poster
   frame taken a quarter of the way in.

2. For text-heavy captures such as terminal sessions, keep the native height
   and lower the CRF so the type stays sharp:

   ```bash
   npm run encode:video -- -h 1080 -c 24 ~/Desktop/wizard.mov
   ```

   Flags: `-h` output height (default 900), `-c` CRF (default 28, lower is
   sharper and larger), `-p` poster timestamp in seconds, `-o` output dir.

3. Check the poster with `ffprobe`/an image viewer. The first frames of a demo
   are often an empty terminal or a splash screen; if the default frame is
   blank, re-run with `-p <seconds>` pointing at a representative moment.

4. Embed it. `<Video>` is global in MDX, so no import line is needed. Pass the
   real pixel dimensions so the page reserves the right box before the file
   loads (`ffprobe -v error -show_entries stream=width,height -of csv=p=0 file.mp4`):

   ```mdx
   <Video
     src="/video/my-recording.mp4"
     width={1618}
     height={1080}
     caption="What the reader is looking at"
   />
   ```

   Add `portrait` for simulator and emulator captures, which are capped at
   480px tall instead of filling the content column.

## Rules

- Never commit a GIF. The same ten second capture is roughly thirty times
  larger as a GIF than as H.264.
- Never commit an unencoded recording. A raw QuickTime capture is several
  megabytes; the pipeline typically cuts that by 4-5x with no visible loss.
- Every `.mp4` here has a matching `.jpg`. The component derives the poster
  path from the video path, so a missing poster is a broken image.
- Once this directory passes a few tens of megabytes, move the files behind a
  CDN and pass absolute URLs to `src` rather than growing the git history.

The component lives in `src/components/Video/`, the script in
`scripts/encode-video.sh`.
