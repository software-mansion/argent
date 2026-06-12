import type { ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../contract";
import { runVegaFastCli } from "../../../utils/vega-fast-cli";
import { parseVegaPageSource } from "./vega/source-parser";

export const vegaRequires: ToolDependency[] = ["vega"];

const EMPTY_TREE: DescribeNode = {
  role: "Screen",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [],
};

const UNAVAILABLE_HINT =
  "No UI tree from the Vega automation toolkit. The toolkit attaches at app launch — " +
  "relaunch the foreground app (e.g. via restart-app) and call describe again.";

// A served getPageSource is multi-KB; anything shorter is an empty root.
const PAGE_SOURCE_EMPTY_LENGTH = 50;

/**
 * Describe the current Vega (Fire TV) screen via `vega-fast-cli inspect`, which
 * returns the on-device automation toolkit's `getPageSource` XML (the host CLI
 * deploys/starts the on-device server as needed). Parsed into the shared
 * DescribeNode tree.
 *
 * The toolkit enable flag is owned by the app-lifecycle tools (`launch-app` /
 * `restart-app` set it before launching) and is only read at app launch. If the
 * toolkit is unreachable (flag never set, or the app started before it attached)
 * `inspect` yields an empty/failed result → we surface an empty tree with a hint
 * to relaunch rather than a hard error.
 */
export async function describeVega(_serial: string): Promise<DescribeTreeData> {
  let xml: string;
  try {
    const { stdout } = await runVegaFastCli(["inspect"]);
    xml = stdout.trim();
  } catch {
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
  if (xml.length < PAGE_SOURCE_EMPTY_LENGTH) {
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
  return { tree: parseVegaPageSource(xml), source: "vega-automation" };
}
