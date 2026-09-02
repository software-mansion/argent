# iOS

Read this file one time, before you record or replay on an iOS simulator. Use the same UDID in each call. If more than one simulator is booted, pass `--device <udid>` to the standalone runner.

## Launch

- Record `restart-app` with only `udid` and `bundleId`. Only `restart-app` starts the app with the instrumentation that is necessary for the flow tree. `launch-app` can move a process without a tree to the front.
- After `launch:`, the runner reads only that app until the next raw `tool:` step. If a replay read shows a different app, this is the cause.
- After `restart-app`, call `native-devtools-status` until it reports `connected`. Then record the first-screen wait. A tap or a wait before that can give a warning one time. Record it again. Only a warning that stays is a defect.

## Discovery and selectors

- `describe` and `native-describe-screen` show the accessibility tree. The flow tree is the native view hierarchy. An id that `describe` does not show can work. Do a test of it in a scratch fragment ([Record](../record.md#coordinate-fallback-gate)).
- Do not copy a `role` from `describe` into a flow selector. The two trees give different roles to the same element.
- A live `await-ui-element` reads the accessibility tree. If an id is not in that tree, record the wait on the text or the label of the element. In the polish pass, change the selector to the id, and let the replay prove it.
- The platform discovery tool is `native-find-views`. For the coordinate fallback gate, query ids and labels with it. If no term helps, call `native-full-hierarchy` with narrow fields and `maxDepth: 100`.
- To find which view receives a tap below an overlay, use `native-user-interactable-view-at-point`.
- `describe` does not report focus on iOS. After the `keyboard` step, make sure that the field has the typed value.

## Missing flow tree

The flow tree is available only for an app that Argent started with instrumentation.

1. If Metro, Expo, Xcode, an icon, or an earlier process started the app, call `restart-app`. Go back to the source screen. Then record again.
2. If the warning stays after the `restart-app`, call `stop-all-simulator-servers` with `devices: [<this UDID>]`. A call without `devices` stops the devices of all agents on this machine. Then call `restart-app`. Record again.
3. If the app stays disconnected, call `native-devtools-status` with the same UDID and bundle id. Do what its `message` says, but do not restart the tool server while a recording is open. The restart ends the recording.
4. If the failure continues, report that the instrumentation stops the flow. A missing tree does not let you use coordinates in a QA flow.

## System apps

A `com.apple.*` app does not get a flow tree. Use this form only for a `com.apple.*` app:

- Keep `launch:`. It passes after about 16 seconds.
- Use raw `tool: await-ui-element` checks and point taps from `describe`, each with an echo.
- For text, use a point focus tap, a raw `keyboard` with `text` and `delayMs: 500`, then a raw `keyboard` with `key: "enter"`.
- Use raw swipes with `momentum: false` and `durationMs` of at least 150, because the tree is necessary for `scroll-to`.
- Put a `wait:` or a raw wait before a gesture that follows a screen change.
- A recorded wait gives a warning that the runner tree is unavailable. This warning is expected. Keep the wait as a raw `tool:` step.

Each point gesture passes with the [selector-less gesture warning](../warnings.md#selector-less-gesture-warning). Report that the coordinates are not portable. Such a flow cannot complete `argent-qa-flows`. An app that is not a `com.apple.*` app, with broken instrumentation, gets the same point form, but `launch:` fails for it. Start that flow with a raw `tool: restart-app`, which makes it a fragment. Report the problem.
