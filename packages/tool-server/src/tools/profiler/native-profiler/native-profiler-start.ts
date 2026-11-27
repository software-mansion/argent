import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { macosAppRef, type MacosAppApi } from "../../../blueprints/macos-app";
import { resolveDevice } from "../../../utils/device-info";
import { assertSupported } from "../../../utils/capability";
import { ensureDeps } from "../../../utils/check-deps";
import { startNativeProfilerIos } from "./platforms/ios";
import { startNativeProfilerAndroid } from "./platforms/android";
import { startNativeProfilerMacos } from "./platforms/macos";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";
import { nativeNetworkCaptureWarning } from "../../../utils/profiler-shared/network-capture-warning";
import { trackProfilingRun } from "../../../utils/profiling-devices";

const capability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  macos: { app: true, catalyst: true },
} as const;

export { handleXctraceExit } from "./platforms/xctrace";

const zodSchema = z.object({
  device_id: metroDeviceIdParam(
    "Target device id from `list-devices` (iOS UDID<flag:macos-apps>, Mac app id</flag:macos-apps> or Android serial)."
  ),
  app_process: z
    .string()
    .optional()
    .describe(
      "iOS executable/name or Android package (auto-detects foreground app if omitted)<flag:macos-apps>; omit for Mac apps</flag:macos-apps>."
    ),
  template_path: z
    .string()
    .optional()
    .describe(
      'iOS<flag:macos-apps>/Mac app</flag:macos-apps> Instruments `.tracetemplate` path or built-in name (e.g. "Time Profiler"; default: bundled template).'
    ),
  malloc_stack_logging: z
    .boolean()
    .optional()
    .describe(
      "iOS<flag:macos-apps>/Mac apps</flag:macos-apps> only: restart app with allocation stacks from launch (adds overhead; leave off for CPU/hang timing)."
    ),
});

export const nativeProfilerStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string; warning?: string }
> = {
  id: "native-profiler-start",
  // iOS can outlast the 30s MCP fetch timeout, whose replay would start a second xctrace.
  longRunning: true,
  description: `Start native profiling: Instruments (CPU, hangs, leaks) on iOS<flag:macos-apps> and Mac apps</flag:macos-apps>, or Perfetto (CPU, jank, memory) on Android.
Use when profiling native performance — launch the target app first, reproduce the scenario, then call \`native-profiler-stop\` while it runs.<flag:macos-apps> Mac apps need a dev-signed build launched via Argent (use "Time Profiler" if signing/WebKit blocks the bundled template, or set \`malloc_stack_logging: true\` for leak stacks).</flag:macos-apps>
Returns \`{ status: "recording", pid, traceFile, warning? }\` (warns on iOS/Android if native network capture is active). Fails if the app, xctrace, or adb is unavailable.`,
  zodSchema,
  interaction: {
    startedMsg: () => "Starting native profiler",
    completedMsg: () => "Started native profiler",
    failedMsg: ({ failureSignal }) =>
      `Failed to start native profiler: ${failureSignal.error_code}`,
  },
  capability,
  services: (params) => {
    const device = resolveDevice(params.device_id);
    return {
      session: nativeProfilerSessionRef(device),
      ...(device.platform === "macos" ? { macosApp: macosAppRef(device) } : {}),
    };
  },
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-start", capability, device);

    // Dispatch on the session's platform, not the udid shape: tests pair a
    // synthetic platform with a fake udid that fails the iOS-UDID regex.
    let started: Awaited<ReturnType<typeof startNativeProfilerAndroid>>;
    let warning: string | undefined;
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      started = await startNativeProfilerIos(api, params);
      warning = nativeNetworkCaptureWarning(params.device_id);
    } else if (api.platform === "macos") {
      await ensureDeps(["xcrun"]);
      ({ warning, ...started } = await startNativeProfilerMacos(
        api,
        services.macosApp as MacosAppApi,
        params
      ));
    } else {
      await ensureDeps(["adb"]);
      started = await startNativeProfilerAndroid(api, params);
      warning = nativeNetworkCaptureWarning(params.device_id);
    }
    trackProfilingRun(device.id, api);
    return warning ? { ...started, warning } : started;
  },
};
