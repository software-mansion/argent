import type { ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../contract";
import {
  ensureAutomationToolkitEnabled,
  fetchVegaPageSource,
} from "../../../utils/vega-automation";
import { parseVegaPageSource } from "./vega/source-parser";

export const vegaRequires: ToolDependency[] = ["vega"];

const EMPTY_TREE: DescribeNode = {
  role: "Screen",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [],
};

/**
 * Describe the current Vega (Fire TV) screen via the on-device automation
 * toolkit's `getPageSource`. Ensures the toolkit flag is set (idempotent), then
 * fetches + parses the accessibility XML into the shared DescribeNode tree.
 *
 * If the toolkit is unreachable (flag was set but the foreground app started
 * before it, so it never attached), returns an empty tree with a hint to
 * relaunch the app rather than a hard error — the flag only takes effect at
 * app launch.
 */
export async function describeVega(serial: string): Promise<DescribeTreeData> {
  await ensureAutomationToolkitEnabled(serial);
  const page = await fetchVegaPageSource(serial);
  if (!page.ok) {
    return {
      tree: EMPTY_TREE,
      source: "vega-automation",
      hint:
        "No UI tree from the Vega automation toolkit. The toolkit attaches at app launch — " +
        "relaunch the foreground app (e.g. via restart-app) and call describe again.",
    };
  }
  return { tree: parseVegaPageSource(page.xml), source: "vega-automation" };
}
