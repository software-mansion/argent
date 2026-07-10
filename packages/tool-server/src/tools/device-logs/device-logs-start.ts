import { z } from "zod";
import type { ServiceRef, ToolDefinition } from "@argent/registry";
import {
  deviceLogSessionRef,
  type DeviceLogSessionApi,
} from "../../blueprints/device-log-session";
import { resolveDevice } from "../../utils/device-info";

const schema = z.object({
  device_id: z.string().describe("Physical iOS device or iOS simulator id from list-devices."),
  process: z
    .string()
    .optional()
    .describe("Optional process name filter, for example Maps. Omit to capture all device logs."),
});

const capability = { apple: { simulator: true, device: true } } as const;

export const deviceLogsStartTool: ToolDefinition<
  z.infer<typeof schema>,
  { status: "recording"; outputFile: string; startedAtMs: number }
> = {
  id: "device-logs-start",
  capability,
  description:
    "Start continuous Apple unified-log capture for an iOS simulator or physical iPhone. Keep it running while gestures and native profiling execute, then call device-logs-stop to materialize the log artifact.",
  zodSchema: schema,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.device_id);
    return { logs: deviceLogSessionRef(device) };
  },
  async execute(services, params) {
    const logs = services.logs as DeviceLogSessionApi;
    const result = await logs.start({
      process: params.process,
    });
    return { status: "recording", ...result };
  },
};
