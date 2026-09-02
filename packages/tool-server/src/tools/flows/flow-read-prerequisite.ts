import { z } from "zod";
import * as fs from "node:fs/promises";
import type { FileInputSpec, ToolContext, ToolDefinition } from "@argent/registry";
import { parseFlow } from "./flow-utils";
import { resolveFlowSource } from "./flow-run";

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
Returns { flow, executionPrerequisite }: the logical name, plus the precondition its author recorded
verbatim. Empty when none was declared, which is always so for a self-contained scenario: one opening
on a launch may declare no prerequisite, because it builds its own start state.
Use when deciding whether the device already sits where a fragment expects it (correct app foregrounded,
correct account, correct screen) before committing to a run, or when relaying that requirement to a human.
Touches no device: nothing is launched, tapped, dispatched or torn down, and no simulator or emulator
needs booting, so calling this costs nothing but a file read.
Fails if the flow file does not exist.
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

    return {
      flow: flowName,
      executionPrerequisite: flow.executionPrerequisite,
    };
  },
};
