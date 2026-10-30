import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { ToolDependency } from "@argent/registry";
import type { DescribeTreeData } from "../../contract";
import {
  harmonyDisplay,
  harmonyDumpLayout,
  remainingBudget,
  HARMONY_DISPLAY_TIMEOUT_MS,
  HARMONY_INTERACTION_TIMEOUT_MS,
  UITEST_TIMEOUT_MS,
} from "../../../../utils/harmony-uitest";
import { parseHarmonyLayout } from "./layout-parser";

export const harmonyRequires: ToolDependency[] = ["hdc"];

/** A suspended panel still dumps its last-composited windows, indistinguishable from a live screen. */
const ASLEEP_HINT =
  "The display is off. This tree is what was last composited, and injected taps land nowhere " +
  "until the panel is on. Wake it with `button` (power), then describe again.";

const EMPTY_HINT =
  "The layout dump contains no windows. The foreground app may still be starting — " +
  "call describe again, or screenshot to see what is on screen.";

/**
 * The wait tools' fetcher. A poll with no budget left (the last one, on the
 * deadline) never settles, as on every other backend, so it cannot read as a
 * failed fetch.
 */
export function pollHarmonyTree(connectKey: string, budgetMs: number): Promise<DescribeTreeData> {
  if (budgetMs <= 0) return new Promise(() => {});
  return describeHarmony(connectKey, budgetMs);
}

/**
 * `timeoutMs` bounds the whole read: an abandoned `uitest` client holds the
 * device's queue until killed, which charges the caller's next call.
 */
export async function describeHarmony(
  connectKey: string,
  timeoutMs: number = HARMONY_INTERACTION_TIMEOUT_MS
): Promise<DescribeTreeData> {
  const localPath = join(tmpdir(), `argent-harmony-dump-${process.hrtime.bigint()}.json`);
  const deadline = Date.now() + timeoutMs;
  const display = await harmonyDisplay(
    connectKey,
    Math.min(HARMONY_DISPLAY_TIMEOUT_MS, remainingBudget(connectKey, deadline, "the display read"))
  );
  try {
    const raw = await harmonyDumpLayout(
      connectKey,
      localPath,
      Math.min(UITEST_TIMEOUT_MS, remainingBudget(connectKey, deadline, "the layout dump"))
    );
    const { tree, screen } = parseHarmonyLayout(raw, {
      width: display.width,
      height: display.height,
    });
    const hint = !display.screenOn
      ? ASLEEP_HINT
      : tree.children.length === 0
        ? EMPTY_HINT
        : undefined;
    return {
      tree,
      source: "harmony-uitest",
      screen,
      ...(hint ? { hint } : {}),
      ...(display.screenOn ? {} : { stale: true }),
    };
  } finally {
    await rm(localPath, { force: true }).catch(() => {});
  }
}
