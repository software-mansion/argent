import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@argent/registry";
import { InvalidToolInputError } from "../../utils/capability";
import {
  envRecordSchema,
  flowEnvProblem,
  requireRecordingSession,
  setRecordingEnv,
  PROJECT_ROOT_INPUT,
  type FlowEnv,
  type FlowSavedTo,
} from "./flow-utils";
import { resolveScriptEnv } from "./flow-script-step";

const zodSchema = z.object({
  name: z.string().describe("Test name passed to e2e-start-recording."),
  project_root: z.string().describe("Absolute project root passed to e2e-start-recording."),
  env: envRecordSchema(z.string().nullable()).describe(
    "Variable names to update. A null value removes that name. Omitted names keep their values. Use {{secret:NAME}} for credentials."
  ),
});

export const flowSetEnvTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; env: FlowEnv; savedTo: FlowSavedTo }
> = {
  id: "e2e-set-env",
  description: `Set or remove script environment defaults in an active e2e recording. Use when several script steps need a shared value. Call this tool directly before e2e-add-script.
Returns the updated env map with secret placeholders intact, plus savedTo. If the tool rejects an invalid value or missing secret, correct the input or define the secret and retry.`,
  zodSchema,
  fileInputs: PROJECT_ROOT_INPUT,
  interaction: {
    startedMsg: ({ params }) => `Setting env for e2e test ${params.name}`,
    completedMsg: ({ params }) => `Set env for e2e test ${params.name}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to set env for e2e test ${params.name}: ${failureSignal.error_code}`,
  },
  services: () => ({}),
  async execute(_services, params, ctx?: ToolContext) {
    const session = await requireRecordingSession(params.project_root, params.name);
    const set: FlowEnv = {};
    for (const [name, value] of Object.entries(params.env)) {
      if (value !== null) set[name] = value;
    }
    // A removal is checked for its name only.
    const problem = flowEnvProblem(
      Object.fromEntries(Object.entries(params.env).map(([name, value]) => [name, value ?? ""]))
    );
    if (problem) throw new InvalidToolInputError(`env ${problem}`);
    // A placeholder that cannot resolve would fail every script step at replay.
    resolveScriptEnv(set, params.project_root, ctx?.clientSecrets);

    const { env, savedTo } = await setRecordingEnv(session, params.env);
    return {
      message: `Updated env of "${params.name}" e2e test.`,
      env,
      savedTo,
    };
  },
};
