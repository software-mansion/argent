import type { ActionEnv } from "./flow-actions";
import { fetchFlowTree, supportsFlowTree } from "./flow-tree";
import { getDescribeTapPoint, type DescribeFrame, type DescribeNode } from "../describe/contract";
import { isVisible, nodeAtPoint } from "../../utils/ui-tree-match";
import { settleWithin } from "../../utils/timing";
import { noteSecretField, noteShownSecret } from "../../utils/typed-secrets";

/**
 * What a step that types a `{{secret:…}}` leaves on the screen.
 *
 * The tool that types knows the value it sent. It does not know what the field
 * made of it: an iOS text field with UIKit's default traits capitalizes the
 * first letter and corrects what it takes for a word, and a field can format
 * what it gets. So the runner reads the field before the step and after it, and
 * notes the text the step put there (see `utils/typed-secrets`), so that a
 * failed check that quotes the field does not quote a secret one letter off.
 *
 * Best effort, and never a reason for the step to fail: a tree that cannot be
 * read notes nothing, and the values themselves are noted by the tool.
 */

/** A text-entry tool can be asked to type a secret; nothing else resolves a placeholder. */
export const SECRET_TYPING_TOOLS: ReadonlySet<string> = new Set([
  "keyboard",
  "fill",
  "paste",
  "run-sequence",
]);

/** An element a secret step types into, as it was before the step. */
export interface SecretFieldBefore {
  identifier?: string;
  role: string;
  frame: DescribeFrame;
  label?: string;
  value?: string;
}

/**
 * Longest a read may take. The step has done its work by then, so a source that
 * does not answer costs the step this much and no more.
 */
const READ_TIMEOUT_MS = 2_000;

async function readTree(env: ActionEnv): Promise<DescribeNode | undefined> {
  if (env.signal?.aborted || !supportsFlowTree(env.device.platform)) return undefined;
  const read = await settleWithin(
    fetchFlowTree(env.registry, env.device, env.treeTarget),
    READ_TIMEOUT_MS,
    env.signal
  );
  return read.type === "value" ? read.value.tree : undefined;
}

function nodesOf(node: DescribeNode, acc: DescribeNode[] = []): DescribeNode[] {
  acc.push(node);
  for (const child of node.children) nodesOf(child, acc);
  return acc;
}

function overlaps(a: DescribeFrame, b: DescribeFrame): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The elements keys go to: those that report focus, over `around` when some
 * are. More than one can: a UITextField and the editor view under it both say
 * they are the first responder, and only the field carries the identifier and
 * the text. A source that reports no focus gives the element at the centre of
 * `around`, which is where the step tapped to focus it.
 */
function fieldsIn(tree: DescribeNode, around: DescribeFrame | undefined): DescribeNode[] {
  const focused = nodesOf(tree).filter((node) => node.focused && isVisible(node));
  const over = around ? focused.filter((node) => overlaps(node.frame, around)) : [];
  if (over.length > 0) return over;
  if (focused.length > 0) return focused;
  const tapped = around ? nodeAtPoint(tree, getDescribeTapPoint(around)) : null;
  return tapped ? [tapped] : [];
}

/**
 * Read the elements a secret step is about to type into, and note each one
 * that has an identifier as a field that takes a secret. `typed` is the step's
 * text as written, placeholders unresolved. `around` is the frame the step
 * tapped, when it tapped one.
 */
export async function secretFieldsBefore(
  env: ActionEnv,
  typed: string,
  around?: DescribeFrame
): Promise<SecretFieldBefore[]> {
  const tree = await readTree(env);
  if (!tree) return [];
  return fieldsIn(tree, around).map(({ identifier, role, frame, label, value }) => {
    if (identifier) noteSecretField(env.device.id, identifier, { before: { label, value }, typed });
    return { identifier, role, frame, label, value };
  });
}

/**
 * Read the elements again after the step typed, and note the text each one now
 * shows that it did not show before. Text an element already held stays out of
 * the note when the new text follows it.
 *
 * With nothing in `before`, no element had focus then: the step focused the
 * field itself (a `run-sequence` that taps and then types), so there is nothing
 * to compare with. The elements that have focus now are noted as fields that
 * took a secret, and their text is not: it could be a placeholder.
 */
export async function noteSecretShown(
  env: ActionEnv,
  before: readonly SecretFieldBefore[],
  typed: string
): Promise<void> {
  const tree = await readTree(env);
  if (!tree) return;
  if (before.length === 0) {
    for (const { identifier } of fieldsIn(tree, undefined)) {
      if (identifier) noteSecretField(env.device.id, identifier, { before: {}, typed });
    }
    return;
  }
  for (const was of before) {
    const now = was.identifier
      ? nodesOf(tree).find((node) => node.identifier === was.identifier && isVisible(node))
      : fieldsIn(tree, was.frame).find((node) => !node.identifier && node.role === was.role);
    if (!now) continue;
    for (const key of ["value", "label"] as const) {
      const text = now[key];
      const earlier = was[key];
      if (!text || text === earlier) continue;
      noteShownSecret(
        env.device.id,
        earlier && text.startsWith(earlier) ? text.slice(earlier.length) : text,
        typed
      );
    }
  }
}
