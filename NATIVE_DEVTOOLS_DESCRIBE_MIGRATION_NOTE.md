# Native Describe Status

This note tracks the current `describe` state after the native-devtools migration.

## Current Behavior

- Public `describe` is native-only and app-scoped.
- The public output contract remains a normalized accessibility tree with recursive `children`.
- If `bundleId` is omitted, `describe` auto-targets a safely identifiable connected foreground app.
- If the intended app is backgrounded or auto-targeting is ambiguous, callers must pass `bundleId` explicitly.
- If native devtools are not yet injected into the target app, callers should use `restart-app` and retry.
- Visible Home/system UI is not inspected by `describe`; use `screenshot` when you need to inspect the current simulator state outside a connected app.

## Supporting Tools

- `native-describe-screen` exposes the lower-level app-scoped native accessibility feed.
- `native-view-at-point` inspects the deepest visible native view at a raw native point.
- `native-user-interactable-view-at-point` inspects the deepest native view that would receive touch at a raw native point.

## Contract Notes

- Public `describe` continues to return normalized coordinates in the same space as tap/swipe tools.
- The native adapter clamps partially off-screen frames into the public `[0,1]` contract.
- The native adapter drops elements that have no visible normalized area after clamping.

## Documentation State

- Rules and skills now describe `describe` as native-only.
- User-facing docs no longer describe legacy OS-privacy setup steps for `describe`.
- Recovery guidance now points to `restart-app`, explicit `bundleId`, or `screenshot` depending on the failure mode.

## Remaining Follow-Ups

- Keep aligning secondary skills and examples with the native-only `describe` behavior where helpful.
- Remove or replace any simulator-server internals that are no longer needed for the old `describe` path.
