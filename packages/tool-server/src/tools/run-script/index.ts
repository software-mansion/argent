import type { Registry, ToolCapability, ToolContext, ToolDefinition } from "@argent/registry";
import { resolveDevice } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { runScript } from "./runtime";
import { DEFAULT_TIMEOUT_MS, runScriptZodSchema, type RunScriptParams } from "./schema";
import type { RunScriptResult } from "./types";

const RUN_SCRIPT_FLAG = "run-script";

// Mirrors run-sequence minus chromium/vega: the facade drives describe +
// coordinate taps, which iOS simulators and Android emulators/devices support;
// Chromium is out of scope for v1.
const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export function createRunScriptTool(
  registry: Registry
): ToolDefinition<RunScriptParams, RunScriptResult> {
  return {
    id: "run-script",
    interaction: {
      startedMsg: () => "Running device script",
      completedMsg: ({ result }) =>
        `Ran device script (${result.steps} step${result.steps === 1 ? "" : "s"})`,
      failedMsg: ({ failureSignal }) => `Failed to run device script: ${failureSignal.error_code}`,
    },
    description: `Run an agent-authored JavaScript program that drives the device through many interaction steps in ONE call, deciding what to do next from what it observes on screen (iOS simulator, or Android emulator / device).
Use when a task needs conditionals, loops, retries, or waits BETWEEN steps — e.g. "keep scrolling until a row appears, then open it", "if a cookie banner is present dismiss it, otherwise continue", or filling a form whose fields vary — the decision loop you would otherwise run as many separate tool calls.
The script body is plain JavaScript (NOT TypeScript) run locally in a separate, disposable Node.js process the tool-server spawns for this call, with only two injected globals: \`ui\` (an async device facade — describe / find / exists / visible / tap / fill / pressKey / button / swipe / scrollUntilVisible / await / awaitIdle / launchApp / openUrl / sleep) and a captured \`console\`. Each ui.* call crosses an IPC boundary to the tool-server; only \`ui\` and \`console\` are supported (do not use require, import, fs, or network), and the process is thrown away after the run with no access to tool-server state. \`await\` every ui.* call. The full \`ui\` typings and worked examples live in the \`argent-device-interact\` skill.
Returns { completed: true, logs, steps }: logs is captured console output (tail-capped) and steps is the number of ui.* calls made. Fails if the body is not valid JavaScript (RUN_SCRIPT_SYNTAX_ERROR), if the script's own logic throws (RUN_SCRIPT_THREW), if it outlives timeout_ms — default 120000, max 600000 — (RUN_SCRIPT_TIMEOUT), or if a facade step cannot act on the current screen (RUN_SCRIPT_STEP_FAILED).
Choose this over \`run-sequence\` when the steps are NOT all known in advance: run-sequence executes a fixed list with no logic between steps and observes nothing mid-sequence, whereas run-script observes and branches. Choose this over \`flow-execute\` when there is no authored .yaml flow to replay: flow-execute replays a saved, versioned flow file, whereas run-script runs throwaway exploratory logic you author inline right now.
Disabled unless the \`run-script\` feature flag is enabled (\`argent enable run-script\`) — it executes model-written code locally, so it is opt-in.`,
    searchHint:
      "run-script javascript program exploratory multi-step conditional loop retry wait branch scriptable interaction decision",
    longRunning: true,
    featureFlag: RUN_SCRIPT_FLAG,
    zodSchema: runScriptZodSchema,
    capability,
    // Lazy, like run-sequence: each facade sub-tool resolves its own services
    // from the shared udid, so the tool declares none of its own.
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const device = resolveDevice(params.udid);
      assertSupported("run-script", capability, device);
      return runScript({
        registry,
        device,
        script: params.script,
        timeoutMs: params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        ctx,
      });
    },
  };
}
