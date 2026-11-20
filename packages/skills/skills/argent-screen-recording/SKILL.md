---
name: argent-screen-recording
description: Record a video of an iOS simulator, cabled iPhone, Android emulator/device, or Mac app screen using argent MCP tools. Use when the user asks to record the screen, capture a video of a flow, interaction, or animation, produce a screen recording, or document app behavior as a video clip.
---

`screen-recording-start` and `screen-recording-stop` carry the options (`timeLimitSeconds`, `trimStatic`, `showTouches`) and the result fields. One recording per device at a time; different devices can record concurrently.

## 1. Critical: never leave a recording running

A forgotten recording keeps capturing until its `timeLimitSeconds` cap fires, holding the session and delaying the video. Use both safety nets:

1. **Set yourself a reminder the moment the recording starts**, for the expected end of the interaction. Use whatever your harness provides: a reminder/wakeup or scheduled-task tool if you have one, otherwise a background shell running `sleep <expected-seconds>` whose completion notification pulls you back. When it fires, call `screen-recording-stop`. Do not rely on remembering.
2. **Read the tool-result notes.** While a recording runs, every argent tool result carries a `NOTE:` about it. If the note says the recording already ended, still call `screen-recording-stop`: that is what hands you the file.

## 2. Workflow

1. Get the device booted and the app into the state the video should open on (`list-devices`, `launch-app`, `argent-device-interact`; `argent-macos-app-interact` for a Mac app).
2. Call `screen-recording-start` with `udid` and a `timeLimitSeconds` slightly above the expected interaction length.
3. Set the end-of-recording reminder from §1; this step is not optional.
4. Drive the interaction (`argent-device-interact`, or `argent-macos-app-interact` for a Mac app). Prefer `run-sequence` for tight multi-step interactions so tool-call latency does not pad the video.
5. Call `screen-recording-stop` with the same `udid`. Check `warning` (cap-triggered stop, early encoder exit, dropped frame stream, possibly truncated file) and confirm the file has a sane size before presenting it.

**Where the file lands.** A finished recording is saved durably on the **client**, even with a remote `argent link` tool-server: into `<project>/.argent/recordings/` (the nearest ancestor of the client's working directory with a `.git`/`package.json`/`.argent`), or `~/.argent/recordings/` outside a project. Change it with `argent config set recordings.directory <dir>` (`--scope project` for a per-repo choice). Mention the path to the user, and that the file is untracked: add it to `.gitignore` or clean it up if it shouldn't be committed.

## 3. Platform notes and limits

- **Recordable**: iOS simulators (local and remote `remote:`), physical iPhones on a USB cable, Android emulators and physical Android devices, and Mac apps (AppKit and Mac Catalyst). **Unsupported**: iPhones reachable only over Wi-Fi, tvOS simulators, Chromium apps, Vega/Fire TV and HarmonyOS. For a still frame use `screenshot`; for a replayable interaction script use `argent-create-e2e`.
- **Physical iPhone**: needs `state: "connected"` with `transportType: "wired"` in `list-devices`. The first recording on a Mac compiles a helper (a few seconds) and macOS asks the user to allow camera access for `ios-screen-stream`; tell the user to click Allow. No touch markers are drawn.
- **Mac app**: the video shows the app's window with its menus, sheets and popovers, at the window's resolution; no permission prompt, no ffmpeg, and it works while the Mac is locked. `showTouches` draws the pointer argent clicks with and a ring for each click. The window must not be minimized and must lie whole on one display: the start fails otherwise, and during the recording the video holds its last frame and stop's `warning` says why. A `restart-app` (or a quit) during the recording loses it; a `stop-simulator-server` ends it, with the app asked to write the video first, and the next stop says where it is. If start returns `MACOS_APP_LIBRARY_OUTDATED`, run `restart-app` and start again. The recorder runs inside the app and costs it CPU, so do not record during a native profile of the same app.
- **One size per video**: the video keeps the size of the screen at the start; a later size change is letterboxed. On a foldable simulator, start recording on the panel you need at full size.
- **Remote (`remote:`) simulators**: the video keeps the screen's portrait orientation, so a device in landscape plays sideways.
- **Android**: secure screens (DRM, some password fields) come out black.
- **Watermark**: a faint Argent logo is stamped bottom-left. Turn it off with `argent disable video-watermark`; the flag is read when a recording starts.
