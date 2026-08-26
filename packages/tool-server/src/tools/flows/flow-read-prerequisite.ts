import { z } from "zod";
import * as fs from "node:fs/promises";
import type { FileInputSpec, ToolContext, ToolDefinition } from "@argent/registry";
import { describeRequires, parseFlow } from "./flow-utils";
import { effectiveRequires, resolveFlowSource } from "./flow-run";

const zodSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Name of a saved flow to inspect from `.argent/flows` (e.g. "settings-explore"). Omit when flow_path is set.'
      ),
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
        "Omit when name is set. Absolute path to a co-located flow .yaml on the client and tool server's shared filesystem. This must be supplied through the file-input boundary. Pass the same flow source here as to flow-execute, so the prerequisite you read belongs to the flow that will run; for remote reads, pass name + project_root instead."
      ),
  })
  .superRefine((params, ctx) => {
    if ((params.name === undefined) === (params.flow_path === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          params.name !== undefined
            ? "Pass exactly one flow source: name or flow_path."
            : "Pass exactly one flow source: name or flow_path. flow-read-prerequisite needs " +
              "the flow's name in `name` — it resolves <project_root>/.argent/flows/<name>.yaml.",
        // The ROOT, matching flow-execute: the rule spans both source fields,
        // so it must not be anchored on one of them.
        path: [],
      });
    }
  });

// Must stay field-for-field identical to flow-execute's specs, or the same
// params resolve to different files here and there — e.g. dropping flow_path
// would answer for the saved flow of the same stem. flow-run.ts explains the
// unwrapWhenSet/skipWhenSet choices.
const fileInputs: FileInputSpec[] = [
  {
    target: "flow_path",
    path: "${flow_path}",
    kind: "file",
    optional: true,
    unwrapWhenSet: "name",
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
  { flow: string; executionPrerequisite: string; requires: string }
> = {
  id: "flow-read-prerequisite",
  interaction: {
    startedMsg: () => "Reading flow prerequisite",
    completedMsg: () => "Read flow prerequisite",
    failedMsg: ({ failureSignal }) =>
      `Failed to read flow prerequisite: ${failureSignal.error_code}`,
  },
  description: `Read what a flow demands before it runs, without running it — a saved flow from the .argent/flows/ directory, or an explicit boundary-managed flow_path.
Returns both halves of that contract: \`executionPrerequisite\`, the app/simulator state the flow expects to
start from, and \`requires\`, the target it must be given — its YAML spelling ("platform: [ios, android],
runtimeKind: tv"), or "" when the flow runs anywhere.
\`requires\` is the run's EFFECTIVE block — the root's own plus every fragment the leading \`run:\` chain
enters — and it bounds the run's START: a target it excludes is refused there, not run. A fragment reached
past the first executable step is judged only when that step runs and can refuse mid-run, and a run that
resolves no device is judged against nothing but a \`device\` or \`platform\` you name.
Use when you need to check what state and which target a flow needs before executing it; pass the same flow
source (name or flow_path) you will pass to flow-execute, so what you read is the contract of the flow that
will actually run.
Fails if the flow file does not exist, or if the folded requires block can never be satisfied (the same refusal flow-execute gives).
Address the flow exactly as you will address it in flow-execute: name or flow_path, one and only one; supplying both or neither is rejected. The name goes in \`name\`, which resolves <project_root>/.argent/flows/<name>.yaml.`,
  zodSchema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx?: ToolContext) {
    // The same resolver flow-execute uses, gates included, so the prerequisite
    // reported is the contract of exactly the file flow-execute would run for
    // these params.
    const { filePath, flowName } = await resolveFlowSource(
      params,
      ctx?.fileInputs?.flow_file,
      ctx?.fileInputs?.flow_path
    );
    const flow = parseFlow(await fs.readFile(filePath, "utf8"));
    // The run's folded block, not this file's: a root declaring nothing is
    // still refused for what its leading `run:` fragments demand.
    const requires = await effectiveRequires(flow, filePath, flowName);

    return {
      flow: flowName,
      executionPrerequisite: flow.executionPrerequisite,
      // Rendered, not structured: "" is "no contract" exactly as for
      // executionPrerequisite, and the string is the YAML spelling every
      // refusal quotes back.
      requires: requires ? describeRequires(requires) : "",
    };
  },
};
