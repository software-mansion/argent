# Chromium

Read this file one time, before you record or replay against an Electron app or a Chromium browser with CDP.

## Boot

1. Boot the app with `boot-device` and `electronAppPath`. If arguments are necessary for the app, add `electronArgs`. An app that already runs with CDP shows in `list-devices` as `chromium-cdp-<port>`, and you can record against it without a boot.
2. Take one `screenshot`. Write down its pixel dimensions. An Electron app sets its window dimensions, and no boot argument changes them. For a Chromium browser, pin the dimensions with `electronArgs: ["--window-size=<w>,<h>"]`. Those dimensions key the snapshot baselines, so CI must reproduce them. If the app sizes the window from host or session state, say so in the report.
3. Start the recorder after the boot and before the first app action.

## Launch step

`restart-app` has no Chromium support. The call errors and records nothing. A recorded Chromium flow is a fragment. In the polish pass, add the launch by hand:

```yaml
steps:
  - launch:
      chromium:
        path: ../../app
        args: ["--enable-feature-flag"]
```

The path is relative to the directory of the root flow file (the file that you run). Write the boot arguments accurately. If the boot had no arguments, do not add `args`. If the file has an `executionPrerequisite`, remove it. This is the only launch that you can add by hand.

Each `launch:` step boots one instance. A subsequent launch boots a new instance and stops the previous one for that app path. To give a sub-scenario its own restart, nest an e2e flow with `run:`.

## Directives and discovery

- The runner rejects `pinch` and `rotate`. Use the zoom or rotate controls of the app.
- Scroll with `gesture-scroll`, not `gesture-swipe`. Record a `swipe:` gesture with `gesture-drag`.
- The platform discovery tool is `describe`. It walks the DOM and does not always show runner nodes. Do a test of a candidate in a scratch fragment ([Record](../record.md#coordinate-fallback-gate)).
- A password field is `[password]` in the runner tree. Select it by id or role.
- `describe` reports `focused` on Chromium. Read it before you record `keyboard`.

## Missing flow tree

If there is no reachable CDP session, boot again with `boot-device` and `electronAppPath`. Then record those taps again.

## Replay and CI

- With `flow-execute`, pass `platform: chromium`. Do not pass `device`. The runner boots the declared app path and stops it after the run.
- For a standalone run, use `argent flow run <name> --platform chromium`. Do not pass `--device`, so that the window has reproducible dimensions for snapshots.
- With `--device chromium-cdp-<port>`, the run attaches to that instance, and the first launch only attaches.
