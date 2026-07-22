---
name: argent-screen-recording
description: Record a video of an iOS simulator or Android emulator/device screen using argent MCP tools. Use when the user asks to record the screen, capture a video of a flow, interaction, or animation, produce a screen recording, or document app behavior as a video clip.
---

## 1. Tools

- `screen-recording-start` — start capturing the screen of a booted device to a video file. Frames come from the same simulator-server backend that `screenshot` and the interaction tools already use, and are encoded live to h264 mp4 (constant 30 fps, device-native resolution).
- `screen-recording-stop` — stop the capture, finalize the container, and retrieve the video as a downloadable artifact (`video.hostPath` for co-located clients).

One recording per device at a time; different devices can record concurrently. Recording does not disturb anything else reading the device — a preview window can stay open on the same screen.

---

## 2. Critical: never leave a recording running

A recording does not stop itself before its `timeLimitSeconds` cap, and a forgotten one wastes disk and returns a video full of dead air. Two safety nets exist — use both:

1. **Set yourself a reminder the moment the recording starts.** You know the expected capture length (the interaction you are about to drive). Immediately after `screen-recording-start` returns, schedule a wake-up for that expected end time using whatever your harness provides — a built-in reminder/wakeup or scheduled-task tool if you have one, otherwise a background shell running `sleep <expected-seconds>` whose completion notification pulls you back. When it fires, call `screen-recording-stop`. Do not rely on remembering.
2. **Read the tool-result notes.** While a recording is running, every argent tool result carries a `NOTE:` reminding you it is still going and how to stop it. If the note says the recording already ended (time limit hit), still call `screen-recording-stop` — that is what hands you the file.

---

## 3. Workflow

1. Ensure the target device is booted and the app is in the state you want the video to open on (`list-devices`, `launch-app`, `argent-device-interact`).
2. Call `screen-recording-start` with `udid` and a `timeLimitSeconds` slightly above the expected interaction length (default 180, max 600).
3. Set the end-of-recording reminder described in §2 — this step is not optional.
4. Drive the interaction to capture: gestures, navigation, typing (`argent-device-interact`). Prefer `run-sequence` for tight multi-step interactions so tool-call latency does not pad the video.
5. Call `screen-recording-stop` with the same `udid`. It returns `{ video, durationMs, wallClockMs?, trimmedMs?, warning? }`; `video` is an artifact — use its `hostPath` locally or download it via the artifacts endpoint. The video is already final when stop returns (the watermark is stamped during capture, not in a second pass), so stop takes well under a second.
6. Check `warning`: it reports cap-triggered stops, early encoder exits, a dropped frame stream, and possibly-truncated containers. Verify the file plays (or at least has a sane size) before presenting it to the user.

**Static-frame trimming (on by default).** Stretches where the screen does not change are collapsed: the first second of each still stretch is kept so pauses read naturally, then unchanged frames are dropped until something moves again (a change of even a couple of pixels counts). So you can leave a recording running across slow steps, waits, or thinking time without padding the clip with dead air — a 40-second session with 5 seconds of real activity comes back as a ~5-7 second video. When trimming removed anything, stop also returns `wallClockMs` (real elapsed time) and `trimmedMs` (how much was cut); `durationMs` is always the length of the video you actually get. Pass `trimStatic: false` to `screen-recording-start` when you want a faithful real-time recording (e.g. to measure how long something took on screen).

---

## 4. Platform notes and limits

- **What can be recorded**: anything simulator-server drives — iOS simulators, Android emulators, and physical Android devices. The only length limit is `timeLimitSeconds` (max 600).
- **The timeline is wall-clock accurate**: a device only emits a frame when its screen changes, so captured frames are re-paced onto a steady 30 fps timeline. A recording of a completely still screen is still a full-length video (and compresses to almost nothing), and `durationMs` matches the time you actually recorded.
- **Android**: records at the device's native resolution; secure screens (DRM, some password fields) come out black.
- **Unsupported**: tvOS simulators, physical iPhones, Chromium apps, Vega/Fire TV, and remote (`remote:`-prefixed) simulators — none of them expose a readable frame stream. For a single still frame use `screenshot`; for a replayable interaction script use `argent-create-flow` instead of a video.
- **ffmpeg is required**: it is the encoder, so `screen-recording-start` fails up front with an install hint if it is missing (`brew install ffmpeg`). It is resolved from `PATH` plus the usual Homebrew prefixes.
- **Watermark**: the Argent logo + "By @swmansion" is stamped bottom-left while encoding, faint (20% opacity) and per-pixel contrast-matched to the background (light logo over dark UI, dark logo over light UI). On by default — turn it off with `argent disable video-watermark` (re-enable with `argent enable video-watermark`). The flag is read when the recording starts.
