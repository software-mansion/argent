import { z } from "zod";
import * as fs from "node:fs/promises";
import type { ToolDefinition } from "@argent/registry";
import {
  getFlowPath,
  getActiveFlow,
  getRecordingSession,
  clearActiveFlow,
  clientFileDirective,
  parseFlow,
  serializeFlow,
  selectorToYaml,
  type FlowSavedTo,
  type FlowSelector,
} from "./flow-utils";
import type { TextMatchMode } from "../../utils/ui-tree-match";

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
  }
> = {
  id: "flow-finish-recording",
  description: `Finish recording the active flow. Returns a summary of all recorded steps and the final YAML content. Use when you have added all desired steps and want to finalize the flow file. Fails if no active flow recording is in progress.
You can still edit the .yaml file directly afterwards to remove or reorder steps.`,
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
        case "snapshot":
          return `${n}. snapshot: ${step.name}`;
        case "tool":
        default:
          return `${n}. tool: ${step.name} ${JSON.stringify(step.args)}`;
      }
    });

    clearActiveFlow();

    return {
      message: `Finished recording "${flowName}" flow (${flow.steps.length} steps)`,
      path: filePath,
      executionPrerequisite: flow.executionPrerequisite,
      steps: flow.steps.length,
      summary,
      flowFile,
      savedTo,
    };
  },
};
