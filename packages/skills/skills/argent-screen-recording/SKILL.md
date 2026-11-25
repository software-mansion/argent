---
name: argent-screen-recording
description: Record a screen video with Argent on an iOS simulator, cabled iPhone, Android emulator or device, or Mac app. Use when the user asks for a screen recording or a video of a flow, interaction, animation, or other app behavior.
---

`screen-recording-start` and `screen-recording-stop` carry the options (`timeLimitSeconds`, `trimStatic`, `showTouches`) and the result fields. One recording per device at a time; different devices can record concurrently.

## 1. Critical: never leave a recording running

A forgotten recording keeps capturing until its `timeLimitSeconds` cap fires, holding the session and delaying the video. Use both safety nets:

1. **Set yourself a reminder the moment the recording starts**, for the expected end of the interaction. Use whatever your harness provides: a reminder/wakeup or scheduled-task tool if you have one, otherwise a background shell running `sleep <expected-seconds>` whose completion notification pulls you back. When it fires, call `screen-recording-stop`. Do not rely on remembering.
2. **Read the tool-result notes.** While a recording runs, every argent tool result carries a `NOTE:` about it. If the note says the recording already ended, still call `screen-recording-stop`: that is what hands you the file.

## 2. Workflow

1. Find the target with `list-devices`. Use `argent-device-interact` for mobile targets or `argent-macos-app-interact` for Mac apps. Boot the target if needed, launch the app, and navigate to the first screen you want to capture.
2. Call `screen-recording-start` with `udid` and a `timeLimitSeconds` slightly above the expected interaction length.
3. Set the end-of-recording reminder from §1; this step is not optional.
4. Use `run-sequence` for known steps that need no inspection between actions. Use individual calls when the next action depends on what the app shows.
5. Call `screen-recording-stop` with the same `udid`. Check `warning` (cap-triggered stop, early encoder exit, dropped frame stream, possibly truncated file) and confirm the file has a sane size before presenting it.

**Where the file lands.** A finished recording is saved durably on the **client**, even with a remote `argent link` tool-server: into `<project>/.argent/recordings/` (the nearest ancestor of the client's working directory with a `.git`/`package.json`/`.argent`), or `~/.argent/recordings/` outside a project. Change it with `argent config set recordings.directory <dir>` (`--scope project` for a per-repo choice). Mention the path to the user, and that the file is untracked: add it to `.gitignore` or clean it up if it shouldn't be committed.

## 3. Platform notes and limits

- **Supported targets.** iOS simulators (local and remote), cabled iPhones, Android emulators and devices, and native Mac apps including Mac Catalyst. Use `screenshot` for a still image or `argent-create-e2e` for a replayable test.
- **Physical iPhone**: needs `state: "connected"` with `transportType: "wired"` in `list-devices`. The first recording on a Mac compiles a helper (a few seconds) and macOS asks the user to allow camera access for `ios-screen-stream`; tell the user to click Allow. No touch markers are drawn.
- **Mac apps.** Restore the window and move it fully onto one display before starting. On `MACOS_APP_LIBRARY_OUTDATED`, run `restart-app` and retry. If the error persists, check that the Argent build includes native Mac recording support. Retrieve the video before quitting, restarting, or disconnecting the app. After a disconnect, check the next stop error for the host path of any saved video. Record video and collect a native profile in separate runs because recording adds CPU load to the app.
- **One size per video**: the video keeps the size of the screen at the start; a later size change is letterboxed. On a foldable simulator, start recording on the panel you need at full size.
- **Remote (`remote:`) simulators**: the video keeps the screen's portrait orientation, so a device in landscape plays sideways.
- **Android**: secure screens (DRM, some password fields) come out black.
- **Watermark**: a faint Argent logo is stamped bottom-left. Turn it off with `argent disable video-watermark`; the flag is read when a recording starts.
