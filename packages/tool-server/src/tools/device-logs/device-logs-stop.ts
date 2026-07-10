import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  deviceLogSessionRef,
  type DeviceLogSessionApi,
} from "../../blueprints/device-log-session";
import { resolveDevice } from "../../utils/device-info";
import { isPhysicalIos } from "../../utils/device-info";
import {
  physicalIosAutomationRef,
  type PhysicalIosAutomationApi,
} from "../../blueprints/physical-ios-automation";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";

const schema = z.object({
  device_id: z.string().describe("Physical iOS device or iOS simulator id from list-devices."),
});

const capability = { apple: { simulator: true, device: true } } as const;

export const deviceLogsStopTool: ToolDefinition<
  z.infer<typeof schema>,
  { status: "stopped"; logs: ArtifactHandle; lineCount: number; durationMs: number }
> = {
  id: "device-logs-stop",
  capability,
  description:
    "Stop a device-logs-start capture and return the captured Apple unified logs as a downloadable text artifact.",
  zodSchema: schema,
  services: (params) => {
    const device = resolveDevice(params.device_id);
    return {
      logs: deviceLogSessionRef(device),
      ...(isPhysicalIos(device)
        ? { physicalIos: physicalIosAutomationRef(device) }
        : {}),
    };
  },
  async execute(services, _params, ctx) {
    await (services.physicalIos as PhysicalIosAutomationApi | undefined)?.flushControls();
    const result = await (services.logs as DeviceLogSessionApi).stop();
    const logs = await requireArtifacts(ctx).register(result.outputFile, { mimeType: "text/plain" });
    return {
      status: "stopped",
      logs,
      lineCount: result.lineCount,
      durationMs: result.durationMs,
    };
  },
};
