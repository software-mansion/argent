import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import { getFlowPath, serializeStep } from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe("Flow name to append to"),
  comment: z.string().describe("Message to echo when the flow runs"),
});

export const flowInsertEchoTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { appended: string; flowFile: string }
> = {
  id: "flow_insert_echo",
  description: `Append an echo step to an existing flow. Echo steps print a message when
the flow is replayed — useful as labels between tool calls.

Returns the current contents of the flow file after appending.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const filePath = await getFlowPath(params.name);
    const line = serializeStep({ kind: "echo", message: params.comment });
    await fs.appendFile(filePath, line + "\n", "utf8");

    const flowFile = await fs.readFile(filePath, "utf8");
    return { appended: line, flowFile };
  },
};
