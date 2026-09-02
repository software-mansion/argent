# Android

Read this file one time, before you record or replay on an Android emulator or device. The device id is the adb serial, for example `emulator-5554`.

## Launch

Record `restart-app` with only `udid` (the serial) and `bundleId` (the package). An app that starts from a non-launcher activity has no `launch:` form. Record `restart-app` with `activity`. The step stays a raw tool step, and the flow is a fragment.

## Discovery and selectors

- Keep the id form that the recorder wrote. An unqualified id also matches the qualified resource id.
- `describe` shows trimmed interactable nodes, and it can fall back to `uiautomator`. Thus a healthy `describe` is no proof of the flow tree. A recorded `await-ui-element` that passes with no cross-tree warning is the proof. An id that `describe` does not show can work. Do a test of it in a scratch fragment ([Record](../record.md#coordinate-fallback-gate)).
- The platform discovery tool is `debugger-component-tree` for a React Native app and `describe` for other apps. Do not record `debugger-*` calls.
- `describe` does not report focus on Android. After the `keyboard` step, make sure that the field has the typed value.

## Missing flow tree

If a result says that the android devtools helper is unavailable, unlock the device. Make sure that the device permits `adb install -t`, because Argent installs the helper APK itself. Then record those steps again. The helper is not part of the app, so `restart-app` does not repair it.
