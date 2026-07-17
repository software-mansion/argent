---
name: argent-screen-recording
description: Record a video of an iOS simulator or Android emulator/device screen using argent MCP tools. Use when the user asks to record the screen, capture a video of a flow, interaction, or animation, produce a screen recording, or document app behavior as a video clip.
---

## 1. Tools

- `screen-recording-start` — start capturing the screen of a booted device to a video file. iOS simulators record via `simctl io recordVideo` (h264 mp4); Android emulators/devices record on-device via `screenrecord`.
- `screen-recording-stop` — stop the capture, finalize the container, and retrieve the video as a downloadable artifact (`video.hostPath` for co-located clients).

One recording per device at a time; different devices can record concurrently.

---

## 2. Critical: never leave a recording running

A recording does not stop itself before its `timeLimitSeconds` cap, and a forgotten one wastes disk and returns a video full of dead air. Two safety nets exist — use both:

1. **Set yourself a reminder the moment the recording starts.** You know the expected capture length (the interaction you are about to drive). Immediately after `screen-recording-start` returns, schedule a wake-up for that expected end time using whatever your harness provides — a built-in reminder/wakeup or scheduled-task tool if you have one, otherwise a background shell running `sleep <expected-seconds>` whose completion notification pulls you back. When it fires, call `screen-recording-stop`. Do not rely on remembering.
2. **Read the tool-result notes.** While a recording is running, every argent tool result carries a `NOTE:` reminding you it is still going and how to stop it. If the note says the recording already ended (time limit hit), still call `screen-recording-stop` — that is what hands you the file.

---

## 3. Workflow

1. Ensure the target device is booted and the app is in the state you want the video to open on (`list-devices`, `launch-app`, `argent-device-interact`).
2. Call `screen-recording-start` with `udid` and a `timeLimitSeconds` slightly above the expected interaction length (default 180; Android hard-caps at 180 — larger values are clamped and the applied cap is returned).
3. Set the end-of-recording reminder described in §2 — this step is not optional.
4. Drive the interaction to capture: gestures, navigation, typing (`argent-device-interact`). Prefer `run-sequence` for tight multi-step interactions so tool-call latency does not pad the video.
5. Call `screen-recording-stop` with the same `udid`. It returns `{ video, durationMs, warning? }`; `video` is an artifact — use its `hostPath` locally or download it via the artifacts endpoint.
6. Check `warning`: it reports cap-triggered stops, early process exits, and possibly-truncated containers. Verify the file plays (or at least has a sane size) before presenting it to the user.

---

## 4. Platform notes and limits

- **iOS**: simulators only (no physical iPhones), including tvOS simulators. The mp4 is written host-side; stopping SIGINTs recordVideo and waits for the container to finalize — expect stop to take a second or two on long captures. The video's timeline only advances while the screen changes, so a fully static screen produces a much shorter (even near-zero-length) video than the wall-clock recording window.
- **Android**: works on emulators and physical devices. `screenrecord` caps a segment at 180 s and records at the device's native resolution; secure screens (DRM, some password fields) come out black. The file is pulled from `/sdcard` on stop and removed from the device.
- **Unsupported**: Chromium apps, Vega/Fire TV, and remote (`remote:`-prefixed) simulators. For a single still frame use `screenshot`; for a replayable interaction script use `argent-create-flow` instead of a video.
