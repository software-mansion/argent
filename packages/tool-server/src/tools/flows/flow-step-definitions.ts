import {
  describeSelector,
  describeTextExpectation,
  selectorToYaml,
  SELECTOR_RELATIONS,
  type FlowFile,
  type FlowSelector,
  type FlowStep,
  type WhenCondition,
} from "./flow-utils";
import type { TextMatchMode, WaitCondition } from "../../utils/ui-tree-match";

/**
 * The UI condition shape shared by `await`, `assert` and the UI arm of a
 * `when:` guard — what the condition labels below read.
 */
interface UiCondition {
  condition: WaitCondition;
  selector: FlowSelector;
  expectedText?: string;
  textMatch?: TextMatchMode;
}

// ── Recording-summary spellings ──

// Quote selectors in the step summary the way the flow FILE spells them
// (`id`, bare string for loose, no internal `loose` flag) — the summary is what
// gets read before hand-editing the YAML, so the spellings must agree.
function yamlSelectorLabel(sel: FlowSelector): string {
  return JSON.stringify(selectorToYaml(sel));
}

// Render a text condition for the summary: the comparator is preserved — regex
// patterns as `matches /…/`, exact text as `== "…"`, substrings as
// `contains "…"` — and literals use JSON quoting so embedded quotes and
// control characters stay unambiguous.
function yamlTextConditionLabel(
  sel: FlowSelector,
  expectedText: string | undefined,
  textMatch: TextMatchMode | undefined
): string {
  const selector = yamlSelectorLabel(sel);
  const expected = expectedText ?? "";
  return textMatch === "matches"
    ? `text ${selector} matches /${expected}/`
    : textMatch === "equals"
      ? `text ${selector} == ${JSON.stringify(expected)}`
      : `text ${selector} contains ${JSON.stringify(expected)}`;
}

/** A UI condition in the summary's spelling, for every step kind that carries one. */
function yamlConditionLabel(cond: UiCondition): string {
  return cond.condition === "text"
    ? yamlTextConditionLabel(cond.selector, cond.expectedText, cond.textMatch)
    : `${cond.condition} ${yamlSelectorLabel(cond.selector)}`;
}

// ── Run-report spellings ──

function selectorLabel(sel: FlowSelector): string {
  const parts: string[] = [];
  // The universal selector prints as CSS spells it, so a scope-only target
  // never renders as an empty label.
  if (sel.any) parts.push("*");
  if (sel.text !== undefined) parts.push(`"${sel.text}"`);
  if (sel.textMatches !== undefined) parts.push(`/${sel.textMatches}/`);
  if (sel.identifier) parts.push(`id=${sel.identifier}`);
  if (sel.role) parts.push(`role=${sel.role}`);
  // Each relational scope renders after the fields, parenthesized and
  // recursive, so two steps that differ only by scope don't collapse to the
  // same target label in the report — mirroring `describeSelector`'s
  // reason-string spelling so the two surfaces stay in lockstep (see
  // `conditionLabel`).
  for (const relation of SELECTOR_RELATIONS) {
    const scope = sel[relation];
    if (scope !== undefined) parts.push(`${relation} (${selectorLabel(scope)})`);
  }
  return parts.join(" ");
}

/**
 * One template for rendering an await/assert/when-guard UI condition,
 * parameterized by selector spelling — {@link selectorLabel} for report
 * targets, `describeSelector` for reason strings — so the two surfaces share
 * a single shape and cannot drift.
 */
function conditionLabel(cond: UiCondition, renderSelector: (sel: FlowSelector) => string): string {
  const sel = renderSelector(cond.selector);
  // A text condition checks expectedText against the element the selector
  // locates; the other conditions are about the selector itself.
  if (cond.condition === "text") {
    return `${sel} ${describeTextExpectation(cond.expectedText, cond.textMatch)}`;
  }
  return `${cond.condition} ${sel}`;
}

/**
 * A `when:` guard in one surface's spelling. The platform arm reads the same
 * on every surface, so only the UI arm is parameterized.
 */
function whenLabel(cond: WhenCondition, renderUi: (cond: UiCondition) => string): string {
  return cond.kind === "platform" ? `platform ${cond.platform}` : renderUi(cond);
}

/** A compact rendering of a when guard for report reasons. */
export function describeWhenCondition(cond: WhenCondition): string {
  return whenLabel(cond, (ui) => conditionLabel(ui, describeSelector));
}

/**
 * A `tool:` step's `args` is the one step body the parser does not constrain, so
 * a cyclic YAML alias in a hand-edited file reaches here as a cyclic object and
 * `JSON.stringify` throws on it. Fall back to a marker, the way `parseFlow`
 * already does for the same input class (see `badEntry` in flow-utils) — the
 * summary of a recording that is otherwise fine should not fail on one
 * unrenderable step.
 */
function renderToolArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "[cyclic args]";
  }
}

// ── Step definitions ──

/**
 * How one flow step kind reads to a human — the recording summary and the run
 * report's target — owned by the kind itself, the way each tool owns its log
 * wording in `ToolDefinition.interaction`.
 */
interface FlowStepDefinition<S extends FlowStep> {
  /**
   * The step's summary line minus the `<n>. <kind>: ` prefix
   * {@link summarizeSteps} adds, in the flow file's own spellings.
   */
  summary(step: S): string;
  /**
   * What the step acts on, for the runner's `StepReport.target`. Undefined for
   * a step that addresses nothing (`echo`, `wait`, `launch`, `tool`).
   */
  target(step: S): string | undefined;
}

/** `tap` and `long-press` address a point the same way: a selector, else raw coordinates. */
const POINT_GESTURE_STEP: FlowStepDefinition<Extract<FlowStep, { kind: "tap" | "long-press" }>> = {
  summary: (step) => (step.selector ? yamlSelectorLabel(step.selector) : `(${step.x}, ${step.y})`),
  target: (step) => {
    if (step.selector) return selectorLabel(step.selector);
    if (step.x !== undefined && step.y !== undefined) return `(${step.x}, ${step.y})`;
    return undefined;
  },
};

/** `await` and `assert` differ only in how long the runner waits, never in how they read. */
const UI_CONDITION_STEP: FlowStepDefinition<Extract<FlowStep, { kind: "await" | "assert" }>> = {
  summary: (step) => yamlConditionLabel(step),
  target: (step) => conditionLabel(step, selectorLabel),
};

/**
 * Keyed by {@link FlowStep} kind: a new kind is a compile error here until it
 * says how it reads on both surfaces.
 */
const FLOW_STEP_DEFINITIONS: {
  [K in FlowStep["kind"]]: FlowStepDefinition<Extract<FlowStep, { kind: K }>>;
} = {
  "tool": {
    summary: (step) => `${step.name} ${renderToolArgs(step.args)}`,
    target: () => undefined,
  },
  "echo": {
    summary: (step) => step.message,
    target: () => undefined,
  },
  "launch": {
    summary: (step) => (typeof step.app === "string" ? step.app : JSON.stringify(step.app)),
    target: () => undefined,
  },
  "run": {
    summary: (step) => step.flow,
    // The as-written path, so a report line shows exactly what the flow
    // references (`run ../shared/login.yaml`), not just the attribution stem.
    target: (step) => step.flow,
  },
  "when": {
    summary: (step) => {
      // Pluralize like flow-run's skip reason so the two surfaces agree.
      const count = step.steps.length;
      const cond = whenLabel(step.condition, yamlConditionLabel);
      return `${cond} (${count} step${count === 1 ? "" : "s"})`;
    },
    target: (step) => whenLabel(step.condition, (ui) => conditionLabel(ui, selectorLabel)),
  },
  "tap": POINT_GESTURE_STEP,
  "long-press": POINT_GESTURE_STEP,
  "type": {
    summary: (step) => `${yamlSelectorLabel(step.into)} ← "${step.text}"`,
    target: (step) => `into ${selectorLabel(step.into)}`,
  },
  "await": UI_CONDITION_STEP,
  "assert": UI_CONDITION_STEP,
  "wait": {
    summary: (step) => `${step.ms}ms`,
    target: () => undefined,
  },
  "scroll-to": {
    summary: (step) => `${yamlSelectorLabel(step.target)} (${step.direction})`,
    target: (step) => {
      const dir = step.direction !== "down" ? ` (${step.direction})` : "";
      return `${selectorLabel(step.target)}${dir}`;
    },
  },
  "pinch": {
    summary: (step) =>
      `scale ${step.scale}${step.selector ? ` on ${yamlSelectorLabel(step.selector)}` : ""}`,
    target: (step) => {
      const scale = `scale ${step.scale}`;
      return step.selector ? `${selectorLabel(step.selector)} (${scale})` : scale;
    },
  },
  "rotate": {
    summary: (step) =>
      `by ${step.by}°${step.selector ? ` on ${yamlSelectorLabel(step.selector)}` : ""}`,
    target: (step) => {
      const by = `by ${step.by}°`;
      return step.selector ? `${selectorLabel(step.selector)} (${by})` : by;
    },
  },
  "snapshot": {
    summary: (step) => step.name,
    target: (step) =>
      step.cropOn ? `"${step.name}" cropOn ${selectorLabel(step.cropOn)}` : `"${step.name}"`,
  },
};

/**
 * The definition for a step. A lookup through `step.kind` does not narrow the
 * step and its entry together, so the cast re-stating what the key already
 * guarantees lives here — once, rather than at every call site.
 */
function definitionOf(step: FlowStep): FlowStepDefinition<FlowStep> {
  return FLOW_STEP_DEFINITIONS[step.kind] as FlowStepDefinition<FlowStep>;
}

/** Display-only "what this step acts on" for the runner's `StepReport.target`. */
export function stepTarget(step: FlowStep): string | undefined {
  return definitionOf(step).target(step);
}

/** One human-readable line per recorded step, in the flow file's own spellings. */
export function summarizeSteps(flow: FlowFile): string[] {
  return flow.steps.map((step, i) => `${i + 1}. ${step.kind}: ${definitionOf(step).summary(step)}`);
}
