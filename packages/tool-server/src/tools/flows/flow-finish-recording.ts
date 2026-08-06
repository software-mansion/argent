import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  appIdForPlatform,
  getFlowPath,
  getActiveFlow,
  getRecordingSession,
  clearActiveFlow,
  clientFileDirective,
  parseFlow,
  serializeFlow,
  selectorToYaml,
  LAUNCH_PLATFORMS,
  type FlowFile,
  type FlowSavedTo,
  type FlowSelector,
  type FlowStep,
  type WhenPlatform,
} from "./flow-utils";
import type { TextMatchMode } from "../../utils/ui-tree-match";

/** The first `launch` step anywhere in the flow, including inside a `when:` block. */
function firstLaunch(steps: FlowStep[]): Extract<FlowStep, { kind: "launch" }> | undefined {
  for (const step of steps) {
    if (step.kind === "launch") return step;
    if (step.kind === "when") {
      const nested = firstLaunch(step.steps);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * The platforms a recorded `launch` already limits the flow to, or null when it
 * limits nothing (a bare app id, or no launch at all). A launch declaring no id
 * for the run's platform is a run-time error, so this is the one part of the
 * answer the file already knows — worth offering rather than making the agent
 * re-derive it.
 */
function launchPlatforms(flow: FlowFile): WhenPlatform[] | null {
  const launch = firstLaunch(flow.steps);
  if (!launch) return null;
  const named = LAUNCH_PLATFORMS.filter((p) => appIdForPlatform(launch.app, p) !== null);
  return named.length > 0 && named.length < LAUNCH_PLATFORMS.length ? [...named] : null;
}

/**
 * The question to put to the user once a recording is done: should this flow be
 * restricted to some targets? Asked here, and only here, because this is the
 * moment the whole flow first exists — every earlier tool sees one step. A flow
 * with no block runs everywhere, which is right for most of them and wrong
 * silently for the rest, so the default is offered rather than assumed. Absent
 * once the flow declares a block: the question has been answered.
 */
function requiresPrompt(flow: FlowFile): string | undefined {
  if (flow.requires) return undefined;
  const platforms = launchPlatforms(flow);
  const hint = platforms
    ? ` Its launch step declares an app id only for ${platforms.join(", ")}, so ` +
      `\`requires: { platform: [${platforms.join(", ")}] }\` is the likely answer.`
    : "";
  return (
    `This flow declares no \`requires:\` block, so it will run against any target — including ` +
    `ones it was never recorded on. Ask the user whether it should be restricted, and if so add ` +
    `the block to the YAML yourself (there is no tool for it):\n` +
    `  requires:\n` +
    `    platform: [ios, android]   # one platform or a list; ios covers a remote simulator\n` +
    `    runtimeKind: tv            # tv (Apple TV / Android TV / Fire TV), or mobile for everything else\n` +
    `Both keys are optional and ANDed. Leaving the block out is the right answer for a genuinely ` +
    `portable flow; restrict it when the scenario is platform-specific (a platform-only screen, an ` +
    `OS settings flow) or form-factor-specific (focus/remote navigation rather than touch).${hint}`
  );
}

// Quote selectors in the step summary the way the flow FILE spells them
// (`id`, bare string for loose, no internal `loose` flag) — the summary is what
// gets read before hand-editing the YAML, so the spellings must agree.
function selectorLabel(sel: FlowSelector): string {
  return JSON.stringify(selectorToYaml(sel));
}

// Render a text condition for the summary, one spelling for every step kind
// that carries one (await/assert/when): the comparator is preserved — regex
// patterns as `matches /…/`, exact text as `== "…"`, substrings as
// `contains "…"` — and literals use JSON quoting so embedded quotes and
// control characters stay unambiguous.
function textConditionLabel(
  sel: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined
): string {
  const selector = selectorLabel(sel);
  const expected = expectedText ?? "";
  return textMatch === "matches"
    ? `text ${selector} matches /${expected}/`
    : textMatch === "equals"
      ? `text ${selector} == ${JSON.stringify(expected)}`
      : `text ${selector} contains ${JSON.stringify(expected)}`;
}

const zodSchema = z.object({});

export const flowFinishRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    path: string;
    executionPrerequisite: string;
    steps: number;
    summary: string[];
    flowFile: string;
    savedTo: FlowSavedTo;
    /** Present only while the flow declares no `requires:` block — see {@link requiresPrompt}. */
    requiresPrompt?: string;
  }
> = {
  id: "flow-finish-recording",
  interaction: {
    startedMsg: () => "Finishing flow recording",
    completedMsg: ({ result }) => {
      const flowName =
        result.path
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.ya?ml$/, "") ?? "flow";
      return `Saved recorded flow ${flowName}`;
    },
    failedMsg: ({ failureSignal }) =>
      `Failed to finish flow recording: ${failureSignal.error_code}`,
  },
  description: `Finish recording the active flow. Returns a summary of all recorded steps and the final YAML content. Use when you have added all desired steps and want to finalize the flow file. Fails if no active flow recording is in progress.
You can still edit the .yaml file directly afterwards to remove or reorder steps.
When the finished flow declares no \`requires:\` block, the result carries a \`requiresPrompt\` — put that question to the user (should this flow be restricted to some platforms / to a TV?) and write the block into the YAML yourself if they say yes. This is the moment to ask: it is the first time the whole flow exists, and a flow with no block runs against every target.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, _params) {
    const flowName = getActiveFlow();
    const session = getRecordingSession();

    // Host mode re-reads the file so manual edits made during the recording
    // survive into the summary; in client mode this host never has the file,
    // so the in-memory copy is the truth and travels back in the directive.
    const filePath = session?.filePath ?? getFlowPath(flowName);
    let flowFile: string;
    let savedTo: FlowSavedTo;
    if (session?.persist === "client") {
      flowFile = serializeFlow(session.flow);
      savedTo = clientFileDirective(filePath, flowFile);
    } else {
      flowFile = await fs.readFile(filePath, "utf8");
      savedTo = filePath;
    }
    const flow = parseFlow(flowFile);

    const summary = flow.steps.map((step, i) => {
      const n = i + 1;
      switch (step.kind) {
        case "echo":
          return `${n}. echo: ${step.message}`;
        case "launch":
          return `${n}. launch: ${typeof step.app === "string" ? step.app : JSON.stringify(step.app)}`;
        case "run":
          return `${n}. run: ${step.flow}`;
        case "tap":
        case "long-press":
          return `${n}. ${step.kind}: ${step.selector ? selectorLabel(step.selector) : `(${step.x}, ${step.y})`}`;
        case "type":
          return `${n}. type: ${selectorLabel(step.into)} ← "${step.text}"`;
        case "await":
        case "assert": {
          const tail =
            step.condition === "text"
              ? textConditionLabel(step.selector, step.expectedText, step.textMatch)
              : `${step.condition} ${selectorLabel(step.selector)}`;
          return `${n}. ${step.kind}: ${tail}`;
        }
        case "wait":
          return `${n}. wait: ${step.ms}ms`;
        case "when": {
          // Mirror the await/assert rendering above — selectorLabel spelling,
          // same comparator tail for text guards.
          const cond =
            step.condition.kind === "platform"
              ? `platform ${step.condition.platform}`
              : step.condition.condition === "text"
                ? textConditionLabel(
                    step.condition.selector,
                    step.condition.expectedText,
                    step.condition.textMatch
                  )
                : `${step.condition.condition} ${selectorLabel(step.condition.selector)}`;
          // Pluralize like flow-run's skip reason so the two surfaces agree.
          const count = step.steps.length;
          return `${n}. when: ${cond} (${count} step${count === 1 ? "" : "s"})`;
        }
        case "scroll-to":
          return `${n}. scroll-to: ${selectorLabel(step.target)} (${step.direction})`;
        case "pinch":
          return `${n}. pinch: scale ${step.scale}${step.selector ? ` on ${selectorLabel(step.selector)}` : ""}`;
        case "rotate":
          return `${n}. rotate: by ${step.by}°${step.selector ? ` on ${selectorLabel(step.selector)}` : ""}`;
        case "snapshot":
          return `${n}. snapshot: ${step.name}`;
        case "tool":
        default:
          return `${n}. tool: ${step.name} ${JSON.stringify(step.args)}`;
      }
    });

    const prompt = requiresPrompt(flow);

    clearActiveFlow();

    return {
      message: `Finished recording "${flowName}" flow (${flow.steps.length} steps)`,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
      ...(prompt ? { requiresPrompt: prompt } : {}),
    };
  },
};
