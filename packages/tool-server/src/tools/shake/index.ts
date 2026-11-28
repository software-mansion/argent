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
  description: `Send a shake gesture to an iOS simulator or Android emulator.
Use when triggering shake-bound actions (iOS Undo/Redo Typing, React Native dev menu, shake-to-report).
Returns \`{ shaken: true, count }\`. Fails on physical devices or TVs.`,
  zodSchema: shakeZodSchema,
  searchHint: "shake motion accelerometer undo typing dev menu gesture",
  interaction: {
    startedMsg: ({ params }) =>
      params.count && params.count > 1 ? `Shaking device ${params.count}x` : "Shaking device",
    completedMsg: ({ params }) =>
      params.count && params.count > 1 ? `Shook device ${params.count}x` : "Shook device",
    failedMsg: ({ failureSignal }) => `Failed to shake device: ${failureSignal.error_code}`,
  },
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
