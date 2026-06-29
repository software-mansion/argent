import { z } from "zod";
import * as fs from "node:fs/promises";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import {
  getFlowsDir,
  getFlowPath,
  getActiveFlowOrNull,
  setActiveProjectRoot,
  startRecordingSession,
  clientFileDirective,
  serializeFlow,
  validateFlow,
  type FlowFile,
  type FlowSavedTo,
} from "./flow-utils";

const zodSchema = z.object({
  name: z.string().describe('Name for this flow (e.g. "settings-explore")'),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory (the directory that contains or should contain `.argent/flows/`). The flow file is created at `<project_root>/.argent/flows/<name>.yaml`."
    ),
  launch: z
    .string()
    .optional()
    .describe(
      "App to launch for this end-to-end flow (iOS bundle id / Android package). Recorded so the standalone runner can start the app from scratch. Omit only when recording a fragment."
    ),
  fragment: z
    .boolean()
    .optional()
    .describe(
      "Record a reusable fragment instead of an e2e flow: no launch block, may declare executionPrerequisite, and can be run from other flows."
    ),
  executionPrerequisite: z
    .string()
    .optional()
    .describe(
      'Fragments only: the app/device state assumed on entry (e.g. "Settings app open on General page"). Ignored for e2e flows.'
    ),
});

/**
 * `project_root` is the AGENT's project. The probe tells us whether it exists
 * on this host: when it does (co-located, or a synced checkout) the flow file
 * is written here exactly as before; when it doesn't (remote tool-server) the
 * recording is kept in memory and every mutating flow tool returns a
 * client-write directive so the YAML lands in the agent's project instead of
 * recreating the agent's directory layout on this host.
 */
const fileInputs: FileInputSpec[] = [
  { target: "project_root", path: "${project_root}", kind: "probe" },
];

export const flowStartRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; previousFlow?: string; flowFile: string; savedTo: FlowSavedTo }
> = {
  id: "flow-start-recording",
  description: `Start recording a new flow. Creates a .yaml file in the .argent/flows/ directory.
Use when you want to capture a reusable sequence of device interactions for later replay.
Returns { message, flowFile, savedTo } and optionally { previousFlow } if a prior recording was abandoned.
Fails if the .argent/flows/ directory cannot be created or the flow file cannot be written.

After starting, use flow-add-step to append tool calls — each step is executed
LIVE so you can verify it works before it gets recorded. Use flow-add-echo
to add labels. Call flow-finish-recording when done.

If a recorded step turns out to be wrong, you can edit the .yaml file directly
to remove or reorder steps.`,
  zodSchema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx) {
    setActiveProjectRoot(params.project_root);
    const previousFlow = getActiveFlowOrNull();

    const filePath = getFlowPath(params.name);
    // Default is an e2e flow (captures launch, no prerequisite). It's a fragment
    // when explicitly opted in, or inferred when a prerequisite is given without
    // an app to launch (a documented entry contract implies a reusable fragment).
    const asFragment =
      params.fragment === true ||
      (params.launch === undefined && Boolean(params.executionPrerequisite));
    const flow: FlowFile = asFragment
      ? { executionPrerequisite: params.executionPrerequisite ?? "", steps: [] }
      : { launch: params.launch, executionPrerequisite: "", steps: [] };
    validateFlow(flow);
    const flowFile = serializeFlow(flow);

    // No probe (older client, direct invocation) means the caller shares this
    // filesystem — the pre-boundary assumption — so host persistence stands.
    const probe = ctx?.fileInputs?.project_root;
    const persist = probe && !probe.presentOnHost ? "client" : "host";

    let savedTo: FlowSavedTo;
    if (persist === "host") {
      await fs.mkdir(getFlowsDir(), { recursive: true });
      await fs.writeFile(filePath, flowFile, "utf8");
      savedTo = filePath;
    } else {
      savedTo = clientFileDirective(filePath, flowFile);
    }
    startRecordingSession(params.name, { persist, filePath, flow });

    if (previousFlow && previousFlow !== params.name) {
      return {
        message:
          `Switched active flow from "${previousFlow}" to "${params.name}". ` +
          `Recording "${previousFlow}" was abandoned - but the flow .yaml file has been saved to disk. ` +
          `Now recording "${params.name}".`,
        previousFlow,
        flowFile,
        savedTo,
      };
    }

    return {
      message: `Started recording "${params.name}" flow`,
      flowFile,
      savedTo,
    };
  },
};
