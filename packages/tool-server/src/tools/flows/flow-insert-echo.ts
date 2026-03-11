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
  { appended: string }
> = {
  id: "flow_insert_echo",
  description: "Append an echo step to an existing flow.",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const filePath = await getFlowPath(params.name);
    const line = serializeStep({ kind: "echo", message: params.comment });
    await fs.appendFile(filePath, line + "\n", "utf8");
    return { appended: line };
  },
};
