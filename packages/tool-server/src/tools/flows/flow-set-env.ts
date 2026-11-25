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
  name: z
    .string()
    .describe("Name of the e2e test being recorded: the one passed to e2e-start-recording."),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root of the e2e test being recorded: the same value passed to e2e-start-recording."
    ),
  env: envRecordSchema(z.string().nullable()).describe(
    'Names to set in the e2e test\'s top-level env:, e.g. { "API_URL": "https://api.example.com", "API_KEY": "{{secret:API_KEY}}" }. A null value removes the name. Names not listed keep their values.'
  ),
});

export const flowSetEnvTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { message: string; env: FlowEnv; savedTo: FlowSavedTo }
> = {
  id: "e2e-set-env",
  description: `Set or remove environment values in the top-level \`env:\` of the e2e test being recorded, named by \`name\` + \`project_root\`. Every \`script:\` step of the test receives them; a step's own \`env\` (e2e-add-script) and a run's \`env\` replace the same names.
Use when a script step needs a base URL, a build number or a credential, before you record that step with e2e-add-script, which runs the script with these values. Write a credential as {{secret:NAME}}, never as its value.
Returns { message, env, savedTo }: \`env\` is the whole map as the file now holds it, placeholders unresolved. Fails if the e2e test has no recording in progress, if a name or value is invalid (values must be strings), or if a {{secret:NAME}} is not defined; nothing is changed then.`,
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
