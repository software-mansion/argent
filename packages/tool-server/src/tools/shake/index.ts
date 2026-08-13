import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { shakeZodSchema } from "./schema";
import type { ShakeParams, ShakeResult, ShakeServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const capability: ToolCapability = {
  // Simulator only. A physical iPhone's motion comes from real hardware; there
  // is no host-side hook to fake it, so `device` stays false and a paired phone
  // gets a clean 400 instead of a silent no-op.
  apple: { simulator: true },
  // No `appleRemote`: the local path shells out to `xcrun simctl spawn`, and the
  // sim-remote equivalent is unverified against a real remote host. An
  // unexercised branch here would fail as a no-op that still reports success,
  // which is precisely the failure mode this tool exists to avoid — so remote
  // simulators are rejected until the path can be tested end-to-end.
  //
  // Android emulators only, for the same reason as iOS: a physical phone's
  // accelerometer can't be driven from the host. `unknown` is allowed through
  // because a serial that didn't resolve may still be an emulator; the handler
  // re-checks and rejects a non-emulator serial explicitly.
  android: { emulator: true, unknown: true },
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
Only simulators and emulators are supported — a physical iPhone or Android phone has a real accelerometer that cannot be driven from the host, and is rejected. Fails if the device is not booted.`,
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
    android: androidImpl,
  }),
};
