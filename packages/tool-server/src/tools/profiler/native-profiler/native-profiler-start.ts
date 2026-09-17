import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { assertSupported } from "../../../utils/capability";
import { ensureDeps } from "../../../utils/check-deps";
import { startNativeProfilerIos } from "./platforms/ios";
import { startNativeProfilerAndroid } from "./platforms/android";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";

const zodSchema = z.object({
  device_id: metroDeviceIdParam(
    "Target device id from `list-devices` (iOS UDID or Android serial)."
  ),
  app_process: z
    .string()
    .optional()
    .describe(
      "iOS: the CFBundleExecutable or display name of the app to profile. Android: the app's package name. " +
        "If omitted, auto-detects the currently running foreground app. Only provide this if " +
        "auto-detection picks the wrong app."
    ),
  template_path: z
    .string()
    .optional()
    .describe(
      "iOS-only: path to an Instruments .tracetemplate file (defaults to bundled Argent template). " +
        "Ignored on Android."
    ),
  malloc_stack_logging: z
    .boolean()
    .optional()
    .describe(
      "iOS-only. When true, cold-launches the app under the profiler with Malloc Stack Logging " +
        "enabled so memory leaks carry an allocation backtrace (responsible frame + library). " +
        "Without it, leaks are still detected but unattributable — Instruments reports " +
        "'<Call stack limit reached>'. Trade-offs: this RESTARTS the app (current state is lost), " +
        "adds memory/CPU overhead, and makes the app noticeably slow to launch (every startup " +
        "allocation records a backtrace), so leave it off for pure CPU/hang profiling. Requires a " +
        "non-degraded Xcode: on Xcode 26.4 and later the cold-launch path is broken, so the call is " +
        "rejected up front (re-run without the flag, or set ARGENT_IOS_CAPTURE=device to override if the " +
        "device path works on your host). ARGENT_IOS_CAPTURE=all-processes — e.g. exported globally " +
        "for the normal capture path — also rejects this flag up front, since that fallback cannot " +
        "cold-launch; unset it (or set it to device) first. " +
        "Ignored on Android."
    ),
});

const capability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export { handleXctraceExit } from "./platforms/ios";

export const nativeProfilerStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string }
> = {
  id: "native-profiler-start",
  interaction: {
    startedMsg: () => "Starting native profiler",
    completedMsg: () => "Started native profiler",
    failedMsg: ({ failureSignal }) =>
      `Failed to start native profiler: ${failureSignal.error_code}`,
  },
  capability,
  description: `Start native profiling on a booted device. iOS: Instruments via xctrace (CPU, hangs, memory). Android: Perfetto (CPU, jank, RSS-growth weak signal).
Auto-detects the running app process unless app_process is explicitly provided.
After starting, let the user interact with the app, then call native-profiler-stop.
Use when you want to capture native CPU, hang, and memory data for a running app.
Returns { status, pid, traceFile } confirming the recording has started.
Fails if no app is running on the device, or the profiler cannot attach to the process.`,
  zodSchema,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-start", capability, device);

    // Dispatch on the session's platform, not the udid shape: tests pair a
    // synthetic platform with a fake udid that fails the iOS-UDID regex.
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      return startNativeProfilerIos(api, params);
    }
    await ensureDeps(["adb"]);
    return startNativeProfilerAndroid(api, params);
  },
};
