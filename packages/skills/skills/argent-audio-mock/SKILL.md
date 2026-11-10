---
name: argent-audio-mock
description: Control the sound of an app in an iOS simulator with argent MCP tools. Use when the user wants an app to hear a given audio file or tone as microphone input (voice messages, speech recognition, calls, recording features), or wants to record what an app plays on the speaker (notification sounds, text to speech, players, games). iOS simulators only.
---

## 1. Tools

- `audio-input` — choose what apps hear as microphone input: `source: "file"` (any audio file macOS decodes), `"tone"` (sine wave), or `"microphone"` (release, the real host microphone again). Applies to the whole simulator.
- `audio-record-start` — start recording what one app plays on the speaker (everything it plays, mixed) into a WAV. Optional `muteOutput` keeps the host speakers quiet; the WAV still has the sound.
- `audio-record-stop` — stop and retrieve the WAV (`audio` artifact, `durationMs`, `sampleRate`, `channels`, `warning?`).

Not covered: `AVCaptureSession` audio, `getUserMedia` / HTML5 media in `WKWebView`, tvOS, physical iPhones, remote simulators.

---

## 2. Workflow: microphone input

1. Boot the simulator and make sure the app has microphone permission: `settings-permissions` (microphone), or the app's own prompt.
2. Call `audio-input` with `bundleId` set to the app under test. Apps that Argent launched already carry the audio hook, so this usually returns `appReady: true`.
3. If the result says `appReady: false`, the app was launched before Argent armed the simulator (or before the first audio call, when the `ios-audio-always-inserted` flag is off). Call `restart-app` for it, then call `audio-input` again with `bundleId` and confirm `appReady: true`. If the message says the app has not reported its hook since it started, it was just relaunched: retry once before restarting.
4. Call `audio-input` again right before the action that starts the app's recording or listening (`argent-device-interact`). A file plays from the moment you call it, and again each time the app opens a new audio input, then silence after its end unless `loop: true`. An app that keeps its audio session open between recordings does not open a new input, so the file does not restart by itself: call `audio-input` again to replay it for the next recording.
5. Change the input at any time, even while the app listens. Call `audio-input` with `source: "microphone"` when done.

Do not restart the app again if `appReady` is already true. If it stays `false` after one restart, the app was started by a tool that injects its own libraries (Xcode run, Detox, XCUITest); start it with `launch-app` instead.

A simulator reboot clears the arming; Argent re-arms it, and apps launched afterwards carry the hook again.

---

## 3. Workflow: recording the speaker

1. The hook has to be loaded in the app: true for apps launched by Argent. Otherwise do steps 2-3 above once (`source: "microphone"` is enough when you only record).
2. Call `audio-record-start` with `udid` and `bundleId` **before** the action that makes the app play.
3. Trigger the sound (`argent-device-interact`), wait for it to finish.
4. Call `audio-record-stop` with the same `udid` and `bundleId`. Read `durationMs` and `warning`: a warning means the recording is empty (the sound played before the start, or from web content).
5. Tell the user where the WAV was saved (`audio`, under `.argent/recordings/` of the project).

One recording per app at a time. Do not leave one running: stop it when the sound has ended.

---

## 4. Checking what was heard or played

The app is the judge. Prefer an observable result in the app (a transcript, a level meter) read with `describe` or a screenshot. For the recorded WAV, the file itself is the evidence; compare its `durationMs` with what you expect.
