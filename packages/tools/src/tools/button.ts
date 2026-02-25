import { z } from "zod";
import { Tool } from "../types";
import { ensureServer, sendCommand } from "../simulator-registry";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inputSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  button: z
    .enum([
      "home",
      "back",
      "power",
      "volumeUp",
      "volumeDown",
      "appSwitch",
      "actionButton",
    ])
    .describe("Hardware button to press"),
});

export const buttonTool: Tool<
  typeof inputSchema,
  { pressed: string }
> = {
  name: "button",
  description: `Press a simulator hardware button. Sends Down then Up events automatically.
Supported buttons: home, back, power, volumeUp, volumeDown, appSwitch, actionButton.`,
  inputSchema,
  async execute(input) {
    const entry = await ensureServer(input.udid);
    sendCommand(entry, { cmd: "button", direction: "Down", button: input.button });
    await sleep(50);
    sendCommand(entry, { cmd: "button", direction: "Up", button: input.button });
    return { pressed: input.button };
  },
};
