# @argent/sdk

Typed programmatic client for the argent tool-server — lets JS/TS code drive
simulators/emulators directly instead of shelling out to `argent run`.
Published as part of `@swmansion/argent` (root and `/sdk` subpath exports).

```ts
import { argent } from "@swmansion/argent";

const device = argent.device(); // binds the single booted simulator/emulator
// or: argent.device(udid)      // bind explicitly

await device.tap({ x: 0.5, y: 0.5 }); // alias for gestureTap
await device.gestureSwipe({ fromX: 0.5, fromY: 0.8, toX: 0.5, toY: 0.2 });
const shot = await device.screenshot(); // artifacts land as local files
```

The unscoped client is also available — every method then takes the device id
explicitly:

```ts
const { devices } = await argent.listDevices();
await argent.tap({ udid: devices[0].udid, x: 0.5, y: 0.5 });
```

## How it works

- Every served tool is available as a camelCased method (`gesture-tap` →
  `gestureTap`), plus short aliases `tap`, `swipe`, `pinch`. Dispatch is a
  runtime Proxy; the type surface is derived **type-only** from
  `AllTools` in `@argent/tool-server`'s tools manifest, so param/result types
  come from the same zod schemas the server validates with — with zero runtime
  dependency on the server package. `verbatimModuleSyntax` plus a bundle-time
  metafile assertion (see `packages/argent/scripts/bundle-tools.cjs`) keep it
  that way.
- Param types use the schema's _input_ type, so fields with `.default()` stay
  optional for callers (see `ToolDefinition`'s third generic in
  `@argent/registry`).
- `createArgent()` reuses the same shared tool-server as the MCP server and
  CLI (spawning it on first call if needed), honors `ARGENT_TOOLS_URL` /
  `argent link` for remote routing, and materializes artifact handles
  (screenshots, traces) to local files like `argent run` does.
- `argent.device(id?)` returns a device-bound handle: its method types drop
  `udid` / `device_id` and the handle injects them — schema-aware (only keys
  the tool's served input schema declares, so `.strict()` schemas stay happy),
  with explicit caller params winning over the bound id. With no argument the
  single booted device is auto-detected lazily on first use and cached;
  zero or multiple booted devices throw a descriptive error.

## API sketch

```ts
const sdk = createArgent({ paths });   // paths optional in the published package
await sdk.call("gesture-tap", { udid, x: 0.5, y: 0.5 }); // typed by tool id
await sdk.invoke("screenshot", { udid }); // { data, note, images } envelope
await sdk.callUnchecked("future-tool", { ... }); // newer remote servers
await sdk.listTools();
await sdk.serverUrl();
await sdk.stopServer(); // explicit teardown only; the server idles out on its own
```
