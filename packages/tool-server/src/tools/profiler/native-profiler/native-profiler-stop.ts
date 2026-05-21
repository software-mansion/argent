import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { assertSupported } from "../../../utils/capability";
import { ensureDeps } from "../../../utils/check-deps";
import {
  stopNativeProfilerIos,
  type IosStopResult,
} from "./platforms/ios";
import {
  stopNativeProfilerAndroid,
  type AndroidStopResult,
} from "./platforms/android";

const zodSchema = z.object({
  device_id: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
});

type StopResult = IosStopResult | AndroidStopResult;

const capability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export const nativeProfilerStopTool: ToolDefinition<z.infer<typeof zodSchema>, StopResult> = {
  id: "native-profiler-stop",
  capability,
  description: `Stop native profiling and export trace data.
iOS: sends SIGINT to xctrace, waits for packaging, then exports CPU, hangs, and leaks XML.
Android: sends SIGTERM to the perfetto daemon, polls /proc/<pid>, then \`adb pull\`s the .pftrace.
Call native-profiler-start first.
Use when the user has finished the interaction to profile and you need to export the trace.
Returns { traceFile, exportedFiles } with paths to the exported data.
Fails if no active native-profiler-start session exists for the given device_id.`,
  zodSchema,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-stop", capability, device);

    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      return stopNativeProfilerIos(api);
    }
    await ensureDeps(["adb"]);
    return stopNativeProfilerAndroid(api);
  },
};
