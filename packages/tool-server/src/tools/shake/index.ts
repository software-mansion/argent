import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { shakeZodSchema } from "./schema";
import type { ShakeParams, ShakeResult, ShakeServices } from "./types";
import { iosImpl, iosRemoteImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const capability: ToolCapability = {
  // Simulator only: a physical iPhone's motion is real hardware, with no
  // host-side hook to fake it.
  apple: { simulator: true },
  // `sim-remote spawn` runs the same in-simulator `notifyutil` argv the local
  // path does.
  appleRemote: { simulator: true },
  // Emulators only, for the same reason as iOS. `unknown` is let through and
  // the handler rejects a serial with no emulator console.
  android: { emulator: true, unknown: true },
  // No `vega` block, so a Fire TV is rejected by the capability gate.
  //
  // A TV that is not a separate platform can't be excluded here: an Apple TV
  // simulator is `ios`/`simulator` and an Android TV emulator is
  // `android`/`emulator`. Each platform handler probes the runtime and rejects
  // a TV instead; `supports` can't, being synchronous while the probe is an
  // async `simctl list` / `adb` call.
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
  // No simulator-server is resolved: `simctl`/`adb` are called directly, so a
  // tool that never uses one doesn't spawn it or wait for it to be ready.
  services: () => ({}),
  execute: dispatchByPlatform<ShakeServices, ShakeServices, ShakeParams, ShakeResult>({
    toolId: "shake",
    capability,
    ios: iosImpl,
    iosRemote: iosRemoteImpl,
    android: androidImpl,
  }),
};
