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

const zodSchema = z.object({
  device_id: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
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
});

const capability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export { handleXctraceExit } from "./platforms/ios";

export const nativeProfilerStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string }
> = {
  id: "native-profiler-start",
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

    // The session blueprint already classified the platform at factory time;
    // trust that over re-parsing the udid — it lets tests build a session
    // with a synthetic platform without their fake udid having to match the
    // iOS-UDID regex.
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      return startNativeProfilerIos(api, params);
    }
    await ensureDeps(["adb"]);
    return startNativeProfilerAndroid(api, params);
  },
};
