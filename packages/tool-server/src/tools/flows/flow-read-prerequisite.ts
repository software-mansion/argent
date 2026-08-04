import { z } from "zod";
import * as fs from "node:fs/promises";
import { zodObjectToJsonSchema } from "@argent/registry";
import type { FileInputSpec, ToolContext, ToolDefinition } from "@argent/registry";
import { parseFlow } from "./flow-utils";
import { resolveFlowName, resolveFlowSource } from "./flow-run";

const zodSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Name of a saved flow to inspect from `.argent/flows` (e.g. "settings-explore"). Omit when flow_path is set; otherwise required, via `name` or its `flow_name` alias. Optional in the schema only so the alias is accepted.'
      ),
    flow_name: z.string().optional().describe("Alias for `name`."),
    project_root: z
      .string()
      .describe(
        "Absolute path to the calling agent's project root — the cwd it is working in. With name, the saved flow is read from `.argent/flows/<name>.yaml` under this root; with flow_path, the prerequisite is read from that YAML instead, so pass the agent's cwd."
      ),
    flow_file: z
      .string()
      .optional()
      .describe(
        "Path to the flow .yaml as readable by the tool-server. Internal — the argent client derives it from project_root and name automatically; leave unset."
      ),
    flow_path: z
      .string()
      .optional()
      .describe(
        "Absolute path to a co-located flow .yaml on the client and tool server's shared filesystem. This must be supplied through the file-input boundary. Pass the same flow source here as to flow-execute, so the prerequisite you read belongs to the flow that will run; for remote reads, pass name + project_root instead."
      ),
  })
  .superRefine((params, ctx) => {
    // The alias counts as a name, matching flow-execute.
    const named = params.name !== undefined || params.flow_name !== undefined;
    if (named === (params.flow_path !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass exactly one flow source: name or flow_path.",
        path: ["flow_path"],
      });
    }
  });

const inputSchema: Record<string, unknown> = {
  ...zodObjectToJsonSchema(zodSchema),
  // Zod's JSON Schema conversion cannot represent superRefine. `oneOf` makes
  // the same exactly-one source rule visible to MCP and HTTP clients — the
  // identical addition flow-execute makes, so the pre-flight read advertises
  // the same contract as the run it precedes.
  oneOf: [
    { anyOf: [{ required: ["name"] }, { required: ["flow_name"] }] },
    { required: ["flow_path"] },
  ],
};

// Mirror of flow-execute's specs, field for field: the documented pre-flight is
// "read the prerequisite, then run", so both tools must resolve the same source
// under the same boundary rules. A spec that diverged — e.g. one that silently
// dropped flow_path — would have this tool answer for the saved flow of the
// same stem while flow-execute runs the explicit file: same flow identity, two
// contracts. See flow-run.ts for why a dual-source wire is unwrapped
// (caller-authored flow_path beside name) or dropped (client-derived flow_file
// beside flow_path) rather than resolved.
const fileInputs: FileInputSpec[] = [
  {
    target: "flow_path",
    path: "${flow_path}",
    kind: "file",
    optional: true,
    unwrapWhenSet: "name",
  },
  // Two specs, one target — the alias survives the file-input boundary the same
  // way flow-execute's does (the `name` spec is LAST so it wins the client's
  // last-write-wins merge when both are sent, matching resolveFlowName).
  {
    target: "flow_file",
    path: "${project_root}/.argent/flows/${flow_name}.yaml",
    kind: "file",
    skipWhenSet: "flow_path",
  },
  {
    target: "flow_file",
    path: "${project_root}/.argent/flows/${name}.yaml",
    kind: "file",
    skipWhenSet: "flow_path",
  },
];

export const flowReadPrerequisiteTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { flow: string; executionPrerequisite: string }
> = {
  id: "flow-read-prerequisite",
  interaction: {
    startedMsg: () => "Reading flow prerequisite",
    completedMsg: () => "Read flow prerequisite",
    failedMsg: ({ failureSignal }) =>
      `Failed to read flow prerequisite: ${failureSignal.error_code}`,
  },
  description: `Read the execution prerequisite of a flow without running it — a saved flow from the .argent/flows/ directory, or an explicit boundary-managed flow_path.
Returns the prerequisite description so you can verify the required state is met before calling flow-execute.
Use when you need to check what app/simulator state is required before executing a flow; pass the same flow
source (name or flow_path) you will pass to flow-execute, so the prerequisite you read is the contract of
the flow that will actually run.
Fails if the flow file does not exist.`,
  zodSchema,
  inputSchema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx?: ToolContext) {
    // The same resolver flow-execute uses, gates included: the prerequisite
    // reported here must be the contract of exactly the file flow-execute
    // would run for these params — flow_path clears the statVerified
    // co-location boundary (never uploads, never raw server paths) and reports
    // its basename-derived logical name, while the name branch keeps the
    // flow_file containment under project_root.
    // Same alias fold as flow-execute, and for the same reason: only a name
    // call resolves one, since a flow_path call names no flow.
    const named =
      params.flow_path === undefined
        ? resolveFlowName(params, "flow-read-prerequisite")
        : undefined;
    const { filePath, flowName } = await resolveFlowSource(
      { ...params, name: named },
      ctx?.fileInputs?.flow_file,
      ctx?.fileInputs?.flow_path
    );
    const flow = parseFlow(await fs.readFile(filePath, "utf8"));

    return {
      flow: flowName,
      executionPrerequisite: flow.executionPrerequisite,
    };
  },
};
