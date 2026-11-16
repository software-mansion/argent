---
name: argent-audio-mock
description: Control the microphone input of an app in an iOS simulator with argent MCP tools. Use when the user wants an app to hear a given audio file or tone as microphone input (voice messages, speech recognition, calls, recording features). iOS simulators only.
---

`audio-input` carries the options and the result fields. Local iOS simulators only: tvOS, physical iPhones, remote (`remote:`) simulators, Android and Chromium are refused. Not covered: `AVCaptureSession` audio and web content in `WKWebView`.

## 1. The audio hook

Apps launched after Argent armed the simulator carry the hook. Pass `bundleId` to `audio-input` and read `appReady`:

- `appReady: false`, launched before arming: call `restart-app` once, then `audio-input` again with `bundleId`.
- The message says the app has not reported its hook since it started: it was just relaunched. Retry once before restarting.
- Still `false` after one restart: a tool that injects its own libraries started it (Xcode run, Detox, XCUITest). Start it with `launch-app` instead.

## 2. Workflow: microphone input

1. Grant the microphone permission (`argent-settings-permissions`, or the app's own prompt).
2. Call `audio-input` right before the action that makes the app record or listen (`argent-device-interact`). A file plays from the moment of the call and again each time the app opens a new audio input. An app that keeps its audio session open does not restart the file: call `audio-input` again before each recording.
3. Change the input at any time, even while the app listens. Call `audio-input` with `source: "microphone"` when done.

## 3. Checking the result

The app is the judge. Prefer an observable result in the app (a transcript, a level meter) read with `describe` or a screenshot. For a replayable sequence use `argent-create-e2e`.
