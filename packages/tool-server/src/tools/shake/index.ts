import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { shakeZodSchema } from "./schema";
import type { ShakeParams, ShakeResult, ShakeServices } from "./types";
import { iosImpl, iosRemoteImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const capability: ToolCapability = {
  // Simulator only. A physical iPhone's motion comes from real hardware; there
  // is no host-side hook to fake it, so `device` stays false and a paired phone
  // gets a clean 400 instead of a silent no-op.
  apple: { simulator: true },
  // A remote simulator is still a simulator: `sim-remote spawn` runs the same
  // in-simulator `notifyutil` argv the local path does.
  appleRemote: { simulator: true },
  // Android emulators only, for the same reason as iOS: a physical phone's
  // accelerometer can't be driven from the host. `unknown` is allowed through
  // because a serial that didn't resolve may still be an emulator; the handler
  // re-checks and rejects a non-emulator serial explicitly.
  android: { emulator: true, unknown: true },
  // No `vega`: a Fire TV is rejected here, by the absent block.
  //
  // TV targets that are NOT separate platforms cannot be excluded here. An
  // Apple TV simulator is `ios`/`simulator` and an Android TV emulator is
  // `android`/`emulator` — identical to a phone by id shape and device kind, so
  // the matrix admits them and each platform handler probes the runtime and
  // rejects a TV. `supports` can't do it: it is synchronous, while the runtime
  // kind is an async `simctl list` / `adb` probe.
};

export const shakeTool: ToolDefinition<ShakeParams, ShakeResult> = {
  id: "shake",
  interaction: {
    startedMsg: ({ params }) =>
      params.count && params.count > 1 ? `Shaking device ${params.count}x` : "Shaking device",
    completedMsg: ({ params }) =>
      params.count && params.count > 1 ? `Shook device ${params.count}x` : "Shook device",
    failedMsg: ({ failureSignal }) => `Failed to shake device: ${failureSignal.error_code}`,
  },
  description: `Shake the device (iOS simulator or Android emulator).
Use to trigger anything bound to the shake gesture: iOS's "Undo Typing" / "Redo Typing" prompt in a text field, React Native's developer menu in a debug build, or an app's own shake-to-report handler.
iOS delivers one discrete shake per gesture (the same motion event a physical device raises). Android has no OS-level shake event — the accelerometer is driven through a burst of hard direction changes so app-side detectors fire, and the resting orientation is restored afterwards.
Set \`count\` above 1 when a detector needs sustained motion before it triggers.
Returns { shaken: true, count }.
Works on local and remote (sim-remote) iOS simulators.
Only phone/tablet simulators and emulators are supported.`,
  searchHint: "shake motion accelerometer undo typing dev menu gesture",
  zodSchema: shakeZodSchema,
  capability,
  // Talks to `simctl` / `adb` directly, so no simulator-server is resolved —
  // avoids spawning one (and its ready-wait) for a tool that never uses it.
  services: () => ({}),
  execute: dispatchByPlatform<ShakeServices, ShakeServices, ShakeParams, ShakeResult>({
    toolId: "shake",
    capability,
    ios: iosImpl,
    iosRemote: iosRemoteImpl,
    android: androidImpl,
  }),
};
