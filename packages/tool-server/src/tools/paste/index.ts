import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import {
  physicalIosAutomationRef,
  type PhysicalIosAutomationApi,
} from "../../blueprints/physical-ios-automation";
import { isPhysicalIos, resolveDevice } from "../../utils/device-info";
import { sendCommand } from "../../utils/simulator-client";

const zodSchema = z.object({
  udid: z.string().min(1).describe("iOS simulator or physical-device UDID — paste is iOS-only."),
  text: z.string().describe("Text to paste into the focused field"),
});

type Params = z.infer<typeof zodSchema>;

interface Result {
  pasted: boolean;
}

// Capability gate (HTTP layer + dispatchByPlatform-style consumers) rejects
// Android serials with "Tool 'paste' is not supported on android". The handler
// itself is iOS-only — no platforms/ split needed.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
};

export const pasteTool: ToolDefinition<Params, Result> = {
  id: "paste",
  description: `Fill the focused field on an iOS simulator or physical iPhone by pasting text (fastest text entry).
Use when you need to fill a text input with a long string faster than character-by-character typing.
Returns { pasted: true }. Fails if no field is focused or the simulator server is not running.
Tap the text field first to focus it, then call paste.
If paste doesn't work for a particular field, use the keyboard tool instead.`,
  zodSchema,
  capability,
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return isPhysicalIos(device)
      ? { physicalIos: physicalIosAutomationRef(device) }
      : { simulatorServer: simulatorServerRef(device) };
  },
  async execute(services, params) {
    if (isPhysicalIos(resolveDevice(params.udid))) {
      await (services.physicalIos as PhysicalIosAutomationApi).pasteText(params.text);
      return { pasted: true };
    }
    const api = services.simulatorServer as SimulatorServerApi;
    sendCommand(api, { cmd: "paste", text: params.text });
    return { pasted: true };
  },
};
