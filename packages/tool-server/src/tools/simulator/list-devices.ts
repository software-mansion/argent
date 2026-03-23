import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { listPhysicalDevices } from "../../utils/ios-device";

const zodSchema = z.object({});

export const listDevicesTool: ToolDefinition = {
  id: "list-devices",
  description:
    "List physical iOS devices connected to the host machine via USB or Wi-Fi",
  zodSchema,
  services: () => ({}),
  async execute() {
    const devices = await listPhysicalDevices();
    return { devices };
  },
};
