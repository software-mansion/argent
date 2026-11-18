import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  recordsWithXctrace,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { assertSupported } from "../../../utils/capability";
import { ensureDeps } from "../../../utils/check-deps";
import type { NativeProfilerAnalyzeResult } from "../../../utils/ios-profiler/types";
import { analyzeNativeProfilerIos } from "./platforms/ios";
import { analyzeNativeProfilerAndroid } from "./platforms/android";
import { requireArtifacts, type ArtifactHandle } from "../../../artifacts";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";

const capability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  macos: { app: true },
} as const;

/**
 * `reportFile` is an artifact handle rather than a host path so the client can materialize the
 * report locally wherever the tool-server runs, as react-profiler-analyze does.
 */
type NativeProfilerAnalyzeToolResult = Omit<NativeProfilerAnalyzeResult, "reportFile"> & {
  reportFile: ArtifactHandle | null;
};

const zodSchema = z.object({
  device_id: metroDeviceIdParam(
    "Target device id from `list-devices` (iOS UDID<flag:macos-apps>, Mac app id</flag:macos-apps> or Android serial)."
  ),
});

export const nativeProfilerAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  NativeProfilerAnalyzeToolResult
> = {
  id: "native-profiler-analyze",
  description: `Summarize a native trace saved by native-profiler-stop or restored with profiler-load. Returns a Markdown report with severity and suggested next steps.
Instruments reports CPU hotspots, UI hangs, and memory leaks on iOS<flag:macos-apps> and Mac apps</flag:macos-apps>. Android reports also include jank reasons, main-thread state, garbage collection, and memory growth as a weak leak signal.
Use profiler-stack-query for details behind a finding.`,
  zodSchema,
  interaction: {
    startedMsg: () => "Analyzing native profile",
    completedMsg: () => "Analyzed native profile",
    failedMsg: ({ failureSignal }) =>
      `Failed to analyze native profile: ${failureSignal.error_code}`,
  },
  capability,
  // Parsing a trace from a recording up to RECORDING_CAP_MS long routinely exceeds
  // the 30s MCP fetch timeout, and an aborted call is replayed, not cancelled.
  longRunning: true,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params, ctx) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-analyze", capability, device);

    let result: NativeProfilerAnalyzeResult;
    if (recordsWithXctrace(api.platform)) {
      await ensureDeps(["xcrun"]);
      result = await analyzeNativeProfilerIos(api);
    } else {
      await ensureDeps(["adb"]);
      result = await analyzeNativeProfilerAndroid(api);
    }

    return {
      ...result,
      reportFile: result.reportFile
        ? await requireArtifacts(ctx).register({
            hostPath: result.reportFile,
            kind: "native-profile-report",
          })
        : null,
    };
  },
};
