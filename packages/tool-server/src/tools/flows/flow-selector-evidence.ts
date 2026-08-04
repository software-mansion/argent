import type { FlowStep } from "./flow-utils";
import { AWAIT_UI_ELEMENT_TOOL_ID } from "../await-ui-element";

/**
 * What a flow has POSITIVELY established about a selector — the evidence that
 * makes a later absence check falsifiable.
 *
 * A `hidden` check whose selector the flow never showed present cannot fail: a
 * typo'd selector, a renamed id and the wrong screen entirely all satisfy it.
 * The wait tool itself cannot tell the difference, because it only sees its own
 * poll window and the action that removes an element runs BEFORE the check —
 * so the correct authoring order (prove visible → act → prove gone) always
 * reaches it with nothing matching. The flow is the wider evidence.
 *
 * Shared by the recorder and the runner, which answer it differently on
 * purpose. The recorder REFUSES to write such a check: the screen is still in
 * front of the author, so the fix (record `visible` first) costs one call. The
 * runner still scores it a PASS, carrying `warning` — by then the condition
 * genuinely held, and three legitimate shapes reach it (a scoped `hidden`
 * whose match sits outside the container, a fragment whose
 * `executionPrerequisite` established the element, a baseline absence check),
 * so failing the run would report a regression that did not happen. What the
 * two must agree on is the EVIDENCE RULE below, not the verdict; a hand-edited
 * flow keeps its permanently-green gate and is told so on every run.
 */

/**
 * The identifier/text a selector names, lowercased. `role` is deliberately
 * excluded — "some button existed earlier" is not evidence about THIS element.
 */
export function selectorIdentityTerms(selector: unknown): string[] {
  if (selector === null || typeof selector !== "object") return [];
  const s = selector as { identifier?: unknown; text?: unknown };
  const terms: string[] = [];
  if (typeof s.identifier === "string" && s.identifier !== "") {
    terms.push(`id:${s.identifier.toLowerCase()}`);
  }
  // A regex text locator (`{ text: { matches } }`) names no fixed string, so it
  // cannot serve as, or be satisfied by, positive evidence.
  if (typeof s.text === "string" && s.text !== "") terms.push(`text:${s.text.toLowerCase()}`);
  return terms;
}

/** Every selector a step positively established (acted on or proved present). */
export function establishedTerms(step: FlowStep): string[] {
  switch (step.kind) {
    case "tap":
    case "long-press":
      return selectorIdentityTerms(step.selector);
    case "type":
      return selectorIdentityTerms(step.into);
    case "scroll-to":
      return selectorIdentityTerms(step.target);
    case "await":
    case "assert":
      // A prior `hidden` check proves absence, never presence.
      return step.condition === "hidden" ? [] : selectorIdentityTerms(step.selector);
    case "tool": {
      if (step.name !== AWAIT_UI_ELEMENT_TOOL_ID) return [];
      const args = step.args as { condition?: unknown; selector?: unknown };
      return args.condition === "hidden" ? [] : selectorIdentityTerms(args.selector);
    }
    default:
      return [];
  }
}

/**
 * True when `steps` establish `selector` positively — acted on it, or proved it
 * present. `when:` blocks are walked because a step inside one still ran when
 * its guard held; treating a conditional proof as no proof would reject the
 * correct authoring order for any flow that dismisses an interstitial.
 */
export function selectorEstablishedInSteps(steps: FlowStep[], selector: unknown): boolean {
  const wanted = selectorIdentityTerms(selector);
  if (wanted.length === 0) return false;
  const seen = new Set<string>();
  const walk = (list: FlowStep[]): void => {
    for (const step of list) {
      for (const term of establishedTerms(step)) seen.add(term);
      if (step.kind === "when") walk(step.steps);
    }
  };
  walk(steps);
  return wanted.some((term) => seen.has(term));
}
