---
name: argent-audio-mock
description: Control the sound of an app in an iOS simulator with argent MCP tools. Use when the user wants an app to hear a given audio file or tone as microphone input (voice messages, speech recognition, calls, recording features), or wants to record what an app plays on the speaker (notification sounds, text to speech, players, games). iOS simulators only.
---

`audio-input`, `audio-record-start` and `audio-record-stop` carry the options and the result fields. Local iOS simulators only: tvOS, physical iPhones, remote (`remote:`) simulators, Android and Chromium are refused. Not covered: `AVCaptureSession` audio and web content in `WKWebView`.

## 1. The audio hook

Apps launched after Argent armed the simulator carry the hook. Pass `bundleId` to `audio-input` and read `appReady`:

- `appReady: false`, launched before arming: call `restart-app` once, then `audio-input` again with `bundleId`.
- The message says the app has not reported its hook since it started: it was just relaunched. Retry once before restarting.
- Still `false` after one restart: a tool that injects its own libraries started it (Xcode run, Detox, XCUITest). Start it with `launch-app` instead.

## 2. Workflow: microphone input

1. Grant the microphone permission (`argent-settings-permissions`, or the app's own prompt).
2. Call `audio-input` right before the action that makes the app record or listen (`argent-device-interact`). A file plays from the moment of the call and again each time the app opens a new audio input. An app that keeps its audio session open does not restart the file: call `audio-input` again before each recording.
3. Change the input at any time, even while the app listens. Call `audio-input` with `source: "microphone"` when done.

## 3. Workflow: recording the speaker

1. Make sure the app carries the hook (§1). `source: "microphone"` is enough when you only record.
2. Call `audio-record-start` **before** the action that makes the app play. Set `muteOutput: true` so the host speakers stay quiet; the WAV keeps the sound.
3. Trigger the sound and wait for it to finish.
4. Call `audio-record-stop`. Read `durationMs` and `warning`: an empty recording means the sound played before the start, or from web content.
5. Tell the user where the WAV was saved (`.argent/recordings/` of the project). Do not leave a recording running.

## 4. Checking the result

The app is the judge. Prefer an observable result in the app (a transcript, a level meter) read with `describe` or a screenshot. For a recording, compare `durationMs` with what you expect. For a replayable sequence use `argent-create-e2e`.
