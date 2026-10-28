import { z } from "zod";
import * as fs from "node:fs/promises";
import {
  e2eShadowWarning,
  type FileInputSpec,
  type ToolContext,
  type ToolDefinition,
} from "@argent/registry";
import { E2E_FILE_TEMPLATES, parseFlow } from "./flow-utils";
import { resolveFlowSource } from "./flow-run";

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
    paths: E2E_FILE_TEMPLATES,
    kind: "file",
    skipWhenSet: "flow_path",
  },
];

const zodSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Name of a saved e2e test to inspect from `<project_root>/.argent/e2e`, or `.argent/flows` when it is not there (e.g. "settings-explore").'
      ),
    project_root: z
      .string()
      .describe("Absolute path to the calling agent's project root: the cwd it is working in."),
    flow_file: z
      .string()
      .optional()
      .describe(
        "Path to the e2e test .yaml as readable by the tool-server. Internal: the argent client derives it from project_root and name automatically; leave unset."
      ),
    flow_path: z.string().optional().describe("Absolute path to an e2e test .yaml on the client."),
  })
  .superRefine((params, ctx) => {
    if ((params.name === undefined) === (params.flow_path === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          params.name !== undefined
            ? "Pass exactly one e2e test source: name or flow_path."
            : "Pass exactly one e2e test source: name or flow_path. e2e-read-prerequisite needs " +
              "the e2e test's name in `name` — it resolves <project_root>/.argent/e2e/<name>.yaml, else .argent/flows/<name>.yaml.",
        // The ROOT, matching flow-execute: the rule spans both source fields,
        // so it must not be anchored on one of them.
        path: [],
      });
    }
  });

export const flowReadPrerequisiteTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { flow: string; executionPrerequisite: string; warning?: string }
> = {
  id: "e2e-read-prerequisite",
  description: `Read the execution prerequisite of an e2e test without running it.
Returns { flow, executionPrerequisite, warning? }: the logical name, plus the precondition its author recorded
verbatim. Empty when none was declared, as always for an e2e test that opens on a launch, which builds its
own start state.
Use when deciding whether the device already sits where a fragment expects it (correct app foregrounded,
correct account, correct screen) before committing to a run, or when relaying that requirement to a human.
Touches no device and needs none booted: it only reads the file.
Fails if the e2e test file does not exist.
Address the e2e test exactly as you will address it in e2e-execute: name or flow_path, one and only one; supplying both or neither is rejected.`,
  zodSchema,
  readOnly: true,
  aliases: ["flow-read-prerequisite"],
  interaction: {
    startedMsg: () => "Reading e2e test prerequisite",
    completedMsg: () => "Read e2e test prerequisite",
    failedMsg: ({ failureSignal }) =>
      `Failed to read e2e test prerequisite: ${failureSignal.error_code}`,
  },
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx?: ToolContext) {
    // The same resolver flow-execute uses, gates included, so the prerequisite
    // reported is the contract of exactly the file flow-execute would run for
    // these params.
    const { filePath, flowName, shadowed } = await resolveFlowSource(
      params,
      ctx?.fileInputs?.flow_file,
      ctx?.fileInputs?.flow_path
    );
    const flow = parseFlow(await fs.readFile(filePath, "utf8"));

    return {
      flow: flowName,
      executionPrerequisite: flow.executionPrerequisite,
      ...(shadowed ? { warning: e2eShadowWarning(filePath, shadowed) } : {}),
    };
  },
};
