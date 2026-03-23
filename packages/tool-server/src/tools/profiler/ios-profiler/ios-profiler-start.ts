import { z } from "zod";
import { spawn } from "child_process";
import * as path from "path";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";
import {
  checkIsSimulator,
  detectRunningAppOnSimulator,
  detectRunningAppOnDevice,
} from "../../../utils/ios-device";

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, "Argent.tracetemplate");

const zodSchema = z.object({
  device_id: z.string().describe("iOS Simulator or device UDID"),
  project_root: z
    .string()
    .describe(
      "Absolute path to the user's project root directory. Output files will be saved to <project_root>/argent-profiler-cwd/.",
    ),
  app_process: z
    .string()
    .optional()
    .describe(
      "The exact CFBundleExecutable of the app to profile. If omitted, auto-detects the currently running foreground app on the simulator or device. Only provide this if auto-detection picks the wrong app (e.g. multiple apps running).",
    ),
  template_path: z
    .string()
    .optional()
    .describe(
      "Path to an Instruments .tracetemplate file (defaults to bundled Argent template)",
    ),
});

export const iosInstrumentsStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string }
> = {
  id: "ios-profiler-start",
  description: `Start iOS Instruments profiling via xctrace on a booted simulator or connected device.
Auto-detects the running app process unless app_process is explicitly provided.
After starting, let the user interact with the app, then call ios-profiler-stop.`,
  zodSchema,
  services: (params) => ({
    session: `${IOS_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services, params) {
    const api = services.session as IosProfilerSessionApi;

    if (api.profilingActive) {
      throw new Error(
        `An iOS profiling session is already running (PID: ${api.xctracePid}).`,
      );
    }

    const templatePath = params.template_path ?? DEFAULT_TEMPLATE_PATH;

    let appProcess = params.app_process;
    if (!appProcess) {
      const isSimulator = await checkIsSimulator(params.device_id);
      appProcess = isSimulator
        ? detectRunningAppOnSimulator(params.device_id)
        : await detectRunningAppOnDevice(params.device_id);
    }

    const debugDir = await getDebugDir(params.project_root);
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
      .slice(0, 15);
    const outputFile = path.join(debugDir, `ios-profiler-${timestamp}.trace`);

    api.appProcess = appProcess;
    api.traceFile = outputFile;

    return new Promise((resolve, reject) => {
      const xctraceProcess = spawn("xctrace", [
        "record",
        "--template",
        templatePath,
        "--device",
        params.device_id,
        "--attach",
        appProcess,
        "--output",
        outputFile,
      ]);

      api.xctracePid = xctraceProcess.pid ?? null;

      xctraceProcess.stdout.on("data", (data: Buffer) => {
        const output = data.toString();

        if (
          output.includes("Ctrl-C to stop") ||
          output.includes("Starting recording")
        ) {
          api.profilingActive = true;
          api.wallClockStartMs = Date.now();
          if (api.xctracePid) {
            api.recordingTimeout = setTimeout(
              () => {
                xctraceProcess.kill("SIGINT");
                api.profilingActive = false;
                api.xctracePid = null;
                api.recordingTimeout = null;
              },
              10 * 60 * 1000,
            );
            resolve({
              status: "recording",
              pid: api.xctracePid,
              traceFile: outputFile,
            });
          }
        }
      });

      xctraceProcess.stderr.on("data", (data: Buffer) => {
        const errorOutput = data.toString();
        if (
          errorOutput.includes("Target failed to run") ||
          errorOutput.includes("failed with errors")
        ) {
          api.xctracePid = null;
          if (api.recordingTimeout) {
            clearTimeout(api.recordingTimeout);
            api.recordingTimeout = null;
          }
          reject(new Error(`Failed to attach to iOS process: ${errorOutput}`));
        }
      });

      xctraceProcess.on("error", (err: Error) => {
        api.xctracePid = null;
        if (api.recordingTimeout) {
          clearTimeout(api.recordingTimeout);
          api.recordingTimeout = null;
        }
        reject(new Error(`Failed to start xctrace: ${err.message}`));
      });
    });
  },
};
