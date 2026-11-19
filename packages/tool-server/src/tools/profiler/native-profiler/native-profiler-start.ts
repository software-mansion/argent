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
  macos: { app: true },
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
      "iOS: the CFBundleExecutable or display name of the app to profile. Android: the app's package name. " +
        "If omitted, auto-detects the foreground app; set it only if auto-detection picks the wrong app." +
        "<flag:macos-apps> Do not set it for a Mac app: the tool refuses it, because the device id names the app.</flag:macos-apps>"
    ),
  template_path: z
    .string()
    .optional()
    .describe(
      'iOS<flag:macos-apps> and Mac apps</flag:macos-apps> only. Path to an Instruments .tracetemplate file, or the name of a built-in template such as "Time Profiler" (defaults to the bundled Argent template).'
    ),
  malloc_stack_logging: z
    .boolean()
    .optional()
    .describe(
      "iOS<flag:macos-apps> and Mac apps</flag:macos-apps> only. Enable allocation stacks from app launch. " +
        "Restarts the app, clears its current state, and adds CPU and memory overhead. Leave it off for CPU and hang timing. " +
        "On iOS, attach recordings typically lack allocation stacks. The all-processes capture " +
        "(including ARGENT_IOS_CAPTURE=all-processes) rejects this option and records no leaks." +
        "<flag:macos-apps> On a Mac app, argent restarts the app with MallocStackLogging=1 and then attaches, " +
        "and logging stays active until restart-app. The bundled template can capture stacks for allocations during recording, " +
        "so enable this for older allocations.</flag:macos-apps>"
    ),
});

export const nativeProfilerStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string; warning?: string }
> = {
  id: "native-profiler-start",
  // iOS can outlast the 30s MCP fetch timeout, whose replay would start a second xctrace.
  longRunning: true,
  description: `Start native profiling. Instruments records CPU, hangs, and leaks on iOS<flag:macos-apps> and Mac apps</flag:macos-apps>. Perfetto records CPU, jank, and memory growth on Android.
Start the target app first for an attach recording. Wait for this call to return before reproducing the scenario, then call native-profiler-stop while the app is still running.
On iOS and Android, a warning names apps whose timings may be affected by native network capture.<flag:macos-apps> On a Mac app, a warning says when the app runs with malloc stack logging. Launch the app through Argent and use a development-signed build. If signing blocks profiling in a background session such as SSH, try the "Time Profiler" template for CPU and hangs without leak checks.
With malloc stack logging off, Argent blocks the bundled template if it detects a WebKit heap or the check fails. Use "Time Profiler" to keep the app's state, or set malloc_stack_logging to true to restart the app and record leaks with the bundled template. With logging off, other templates that use the Allocations instrument, including "Leaks" and "Allocations", can freeze an affected app.</flag:macos-apps>`,
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
