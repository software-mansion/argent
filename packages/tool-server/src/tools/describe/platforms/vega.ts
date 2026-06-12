import type { ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../contract";
import { resolveVegaTransport } from "../../../utils/vega-transport";
import { parseVegaPageSource } from "./vega/source-parser";

export const vegaRequires: ToolDependency[] = ["vega"];

const EMPTY_TREE: DescribeNode = {
  role: "Screen",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [],
};

/**
 * Describe the current Vega (Fire TV) screen via the on-device automation
 * toolkit's `getPageSource`, fetched through the on-device agent (keep-alive
 * HTTP, ~3ms — vs a per-call `adb forward` + fresh `fetch`), then parsed into the
 * shared DescribeNode tree.
 *
 * The toolkit enable flag is owned by the app-lifecycle tools (`launch-app` /
 * `restart-app` set it before launching); it is only read at app launch, so
 * touching it here would not help the current frame. If the toolkit is
 * unreachable (flag never set, or the app started before it attached) the agent
 * returns an empty root → we surface an empty tree with a hint to relaunch
 * rather than a hard error.
 */
export async function describeVega(serial: string): Promise<DescribeTreeData> {
  const transport = await resolveVegaTransport(serial);
  const page = await transport.getPageSource();
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
