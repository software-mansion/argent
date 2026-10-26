# Fire TV (Vega / VVD)

Everything in the related SKILL.md still applies; this page covers what is Vega-only.

## Device

- Use the `serial` from `list-devices` as `udid`; start a stopped VVD with `boot-device {vvdImage}`.
- **Stop the VVD** with `vega virtual-device stop` in your shell. The CLI only tracks VVDs it started in the foreground, so it may report "not running" for one started via `boot-device`; to restart that one use `boot-device {vvdImage, force:true}` (stops then re-boots).
- Input ignored → enable developer mode in the VVD: `vsm developer-mode enable`.
- Editing `node_modules` has no effect on a Release build; only Debug `.vpkg` builds load patchable JS.
- Profiling / crashes → `amazon-devices-buildertools-mcp` server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`); docs via its `search_documentation` tool.
- `keyboard` named `key` presses (e.g. `{key:"enter"}`) work on Vega, unlike Apple TV / Android TV.
- `reinstall-app` takes a `.vpkg` as `appPath`.

## Fast Refresh

Build and install a Debug `.vpkg` (`vega device install-app -p <path>`), `npm start`, `vega device start-port-forwarding --port 8081 --forward false`, then `vega device launch-app -a <appId>`. Confirm `http://localhost:8081/json/list` shows a `Hermes React Native` target; `.tsx` edits then hot-reload.

## Debugging the JS runtime

Once that same Debug build + Metro setup is in place, the JS-runtime tools work on a Vega VVD: `debugger-connect`, `debugger-status`, `debugger-evaluate`, `debugger-log-registry` (console logs), `view-network-logs`, and `view-network-request-details`. Verify with `debugger-status`. Vega-specific: on `no_app_connected`, check `vega device start-port-forwarding` **before** relaunching the app: a down device→host forward is the usual cause, and the generic guidance can't know about it. See the `argent-metro-debugger` skill.

Vega's React Native forks RN 0.72 and serves the legacy Hermes inspector, so three things differ from iOS / Android:

- `debugger-component-tree`, `debugger-inspect-element`, `debugger-reload-metro` and the `react-profiler-*` / `profiler-*` tools are **not supported**. Component-tree and inspect-element are hard-blocked: they need `Runtime.addBinding`, which this Hermes acknowledges but never installs. The rest are simply unverified on the legacy inspector. Use `describe` for on-screen structure; with both component tools gated off, component `file:line` tracing has no path on Vega.
- `debugger-status` reports `isNewDebugger: false`.
- `projectRoot` is empty (RN 0.72's Metro sends no project-root header), so lookups that resolve paths against the project root return no location.
