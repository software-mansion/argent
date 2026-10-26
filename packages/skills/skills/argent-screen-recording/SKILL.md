---
name: argent-screen-recording
description: Record a video of an iOS simulator or Android emulator/device screen using argent MCP tools. Use when the user asks to record the screen, capture a video of a flow, interaction, or animation, produce a screen recording, or document app behavior as a video clip.
---

`screen-recording-start` and `screen-recording-stop` carry the options (`timeLimitSeconds`, `trimStatic`, `showTouches`) and the result fields. One recording per device at a time; different devices can record concurrently.

## 1. Critical: never leave a recording running

A forgotten recording keeps capturing until its `timeLimitSeconds` cap fires, holding the session and delaying the video. Use both safety nets:

1. **Set yourself a reminder the moment the recording starts**, for the expected end of the interaction. Use whatever your harness provides: a reminder/wakeup or scheduled-task tool if you have one, otherwise a background shell running `sleep <expected-seconds>` whose completion notification pulls you back. When it fires, call `screen-recording-stop`. Do not rely on remembering.
2. **Read the tool-result notes.** While a recording runs, every argent tool result carries a `NOTE:` about it. If the note says the recording already ended, still call `screen-recording-stop`: that is what hands you the file.

## 2. Workflow

1. Get the device booted and the app into the state the video should open on (`list-devices`, `launch-app`, `argent-device-interact`).
2. Call `screen-recording-start` with `udid` and a `timeLimitSeconds` slightly above the expected interaction length.
3. Set the end-of-recording reminder from §1; this step is not optional.
4. Drive the interaction (`argent-device-interact`). Prefer `run-sequence` for tight multi-step interactions so tool-call latency does not pad the video.
5. Call `screen-recording-stop` with the same `udid`. Check `warning` (cap-triggered stop, early encoder exit, dropped frame stream, possibly truncated file) and confirm the file has a sane size before presenting it.

**Where the file lands.** A finished recording is saved durably on the **client**, even with a remote `argent link` tool-server: into `<project>/.argent/recordings/` (the nearest ancestor of the client's working directory with a `.git`/`package.json`/`.argent`), or `~/.argent/recordings/` outside a project. Change it with `argent config set recordings.directory <dir>` (`--scope project` for a per-repo choice). Mention the path to the user, and that the file is untracked: add it to `.gitignore` or clean it up if it shouldn't be committed.

## 3. Platform notes and limits

- **Recordable**: iOS simulators, Android emulators and physical Android devices. **Unsupported**: physical iPhones, tvOS simulators, Chromium apps, Vega/Fire TV, HarmonyOS and remote (`remote:`-prefixed) simulators. For a still frame use `screenshot`; for a replayable interaction script use `argent-create-e2e`.
- **One size per video**: the video keeps the size of the screen at the start; a later size change is letterboxed. On a foldable simulator, start recording on the panel you need at full size.
- **Android**: secure screens (DRM, some password fields) come out black.
- **Watermark**: a faint Argent logo is stamped bottom-left. Turn it off with `argent disable video-watermark`; the flag is read when a recording starts.
