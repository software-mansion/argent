import type { ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../contract";
import { fetchVegaPageSource } from "../../../utils/vega-inspect";
import { MultipleVegaDevicesError } from "../../../utils/vega-vvd";
import { parseVegaPageSource } from "./vega/source-parser";

// Runs entirely over `adb` and never touches the `vega`/`kepler` CLI, so a running
// VVD with an unsourced `~/vega/env` is still describable.
export const vegaRequires: ToolDependency[] = ["adb"];

const EMPTY_TREE: DescribeNode = {
  role: "Screen",
  frame: { x: 0, y: 0, width: 1, height: 1 },
  children: [],
};

const UNAVAILABLE_HINT =
  "No UI tree from the Vega automation toolkit. The toolkit attaches at app launch — " +
  "relaunch the foreground app (e.g. via restart-app) and call describe again.";

// A real page source is multi-KB; this only catches an empty root.
const PAGE_SOURCE_EMPTY_LENGTH = 50;

/**
 * Describe the current Vega screen from the automation toolkit's `getPageSource`
 * XML. An unreachable toolkit yields an empty tree + relaunch hint; a multi-VVD
 * ambiguity is rethrown. `_serial` is unused — the fetch targets the single
 * running VVD.
 */
export async function describeVega(_serial: string): Promise<DescribeTreeData> {
  let xml: string;
  try {
    xml = (await fetchVegaPageSource()).trim();
  } catch (err) {
    // A multi-VVD ambiguity is a hard error, not a toolkit problem — don't bury it
    // under the relaunch hint.
    if (err instanceof MultipleVegaDevicesError) throw err;
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
  if (xml.length < PAGE_SOURCE_EMPTY_LENGTH) {
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
  // Malformed page source degrades to the same empty-tree + relaunch hint rather
  // than escaping as a raw parse error.
  try {
    return { tree: parseVegaPageSource(xml), source: "vega-automation" };
  } catch {
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
}
