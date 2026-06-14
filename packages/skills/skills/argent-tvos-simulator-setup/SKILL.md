---
name: argent-tvos-simulator-setup
description: Set up and connect to an Apple TV simulator using argent MCP tools. Use when starting a new session on tvOS, booting an Apple TV simulator, getting a tvOS UDID, or before any Apple TV interaction task.
---

## 1. Setup Steps

If you delegate simulator tasks to sub-agents, make sure they have MCP permissions.

1. **Find a booted Apple TV simulator**
   Call `list-devices`. Filter for entries with `runtimeKind: "tv"` — booted simulators are listed first.
   If none are booted, call `boot-device` with `udid: <chosen UDID>`.

2. **Verify connection**
   All tvOS tools (`tv-describe`, `tv-navigate`, `tv-set-focus`, `tv-type`) auto-start the tvOS daemons on first use — no manual server start needed.

## 2. Notes

- tvOS UDIDs look like: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890` (same shape as iOS).
- `list-devices` tags tvOS simulators with `runtimeKind: "tv"`. iOS simulators have `runtimeKind: "mobile"`. Do not mix them — passing an iPhone UDID to a `tv-*` tool fails with a clear error.
- tvOS is **focus-driven**, not touch-driven. None of the iOS/Android interaction tools (`gesture-tap`, `gesture-swipe`, `button`, `keyboard`, etc.) apply on tvOS. See `argent-tvos-interact` for the full interaction workflow.

## 3. Android TV

The `tv-*` tools also drive **Android TV** (leanback) devices — the interaction model is identical, only the target differs:

- Boot an Android TV AVD the same way as any Android emulator — see `argent-android-emulator-setup`. Its serial (`emulator-NNNN`) looks like a phone emulator's, so identify it the same cross-platform way: `list-devices` tags Android TV devices with `runtimeKind: "tv"` (phones/tablets are `runtimeKind: "mobile"`).
- Pass the **serial** (not a UDID) to the `tv-*` tools. The Android TV backend is adb-backed and starts no daemons — there is nothing to wait on after boot.
- `launch-app` resolves the app's `LEANBACK_LAUNCHER` activity automatically on a TV target, so launching an Android TV app needs no special `activity` argument.
- Then use `argent-tvos-interact` for the focus-driven workflow (it covers both Apple TV and Android TV).
