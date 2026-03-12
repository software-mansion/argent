import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, getActiveFlow, serializeStep } from "./flow-utils";

const zodSchema = z.object({
  message: z.string().describe("Message to echo when the flow is replayed"),
});

export const flowInsertEchoTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; flowFile: string }
> = {
  id: "flow_insert_echo",
  description: `Append an echo step to the active flow. Echo steps print a message when
the flow is replayed — useful as labels between tool calls.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const flowName = getActiveFlow();
    const filePath = await getFlowPath(flowName);
    const line = serializeStep({ kind: "echo", message: params.message });
    await fs.appendFile(filePath, line + "\n", "utf8");

    const flowFile = await fs.readFile(filePath, "utf8");
    return {
      message: `Echo added to "${flowName}" flow`,
      flowFile,
    };
  },
};
