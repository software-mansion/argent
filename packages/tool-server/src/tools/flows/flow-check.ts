import { z } from "zod";
import {
  getFailureSignal,
  type Registry,
  type ToolContext,
  type ToolDefinition,
} from "@argent/registry";
import { isFlagOffered } from "../../utils/capability";
import { displayFlowName, E2E_TEST_FILE_INPUTS, readRootTest, rootTestCanonical } from "./flow-run";
import {
  checkFlow,
  parseForCheck,
  type CheckProblem,
  type ToolSchemaLookup,
} from "./flow-preflight";

const zodSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        "Name of a saved e2e test to check from `<project_root>/.argent/e2e`, or `.argent/flows` when it is not there."
      ),
    project_root: z
      .string()
      .describe("Absolute path to the calling agent's project root: the cwd it is working in."),
    e2e_test_file: z
      .string()
      .optional()
      .describe(
        "Path to the e2e test .yaml as readable by the tool-server. Internal: the argent client derives it from project_root and name automatically; leave unset."
      ),
    e2e_test_path: z
      .string()
      .optional()
      .describe("Absolute path to an e2e test .yaml on the client."),
  })
  .superRefine((params, ctx) => {
    if ((params.name === undefined) === (params.e2e_test_path === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass exactly one e2e test source: name or e2e_test_path.",
        path: [],
      });
    }
  });

/** A tool's input schemas, for a tool that a `tool:` step can call on this tool-server. */
function callableSchemas(registry: Registry): ToolSchemaLookup {
  return (tool) => {
    const def = registry.getTool(tool);
    if (def?.featureFlag !== undefined && !isFlagOffered(def.featureFlag)) return undefined;
    return def;
  };
}

export function createCheckFlowTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, { problems: CheckProblem[] }> {
  return {
    id: "e2e-check",
    description: `Check an e2e test without a device and without running a step.
Returns { problems }: each problem that makes e2e-execute refuse the e2e test before its first step, and
each step that fails when it runs for a reason a device does not change, in this e2e test and in the
run: fragments and nested e2e tests its steps reach. Each problem holds at?, code? and message.
at lists the steps from the e2e test to the problem, each { step, run?, e2e?, when? }.
Pass exactly one e2e test source: name (under project_root) or e2e_test_path.`,
    zodSchema,
    readOnly: true,
    // `argent e2e check` calls it.
    hideFromMcp: true,
    fileInputs: E2E_TEST_FILE_INPUTS,
    services: () => ({}),
    interaction: {
      startedMsg: ({ params }) => `Checking e2e test ${displayFlowName(params)}`,
      completedMsg: ({ params }) => `Checked e2e test ${displayFlowName(params)}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to check e2e test ${displayFlowName(params)}: ${failureSignal.error_code}`,
    },
    async execute(_services, params, ctx?: ToolContext) {
      const root = await readRootTest(params, ctx);
      const parsed = parseForCheck(root.text);
      if ("problems" in parsed) return parsed;
      const { flow } = parsed;
      let canonical: string;
      try {
        canonical = rootTestCanonical(registry, root, flow, params.name);
      } catch (err) {
        const code = getFailureSignal(err)?.error_code;
        return {
          problems: [
            {
              ...(code !== undefined && { code }),
              message: err instanceof Error ? err.message : String(err),
            },
          ],
        };
      }
      const problems = await checkFlow({
        flow,
        flowName: root.flowName,
        canonical,
        schemas: callableSchemas(registry),
        project: root.project,
      });
      return { problems };
    },
  };
}
