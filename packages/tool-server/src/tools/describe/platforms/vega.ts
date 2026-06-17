import type { ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../contract";
import { fetchVegaPageSource } from "../../../utils/vega-inspect";
import { MultipleVegaDevicesError } from "../../../utils/vega-vvd";
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
 * Describe the current Vega (Fire TV) screen by fetching the on-device
 * automation toolkit's `getPageSource` XML over `adb forward` (see
 * `fetchVegaPageSource`). Parsed into the shared DescribeNode tree.
 *
 * The toolkit enable flag is owned by the app-lifecycle tools (`launch-app` /
 * `restart-app` set it before launching) and is only read at app launch. If the
 * toolkit is unreachable (flag never set, or the app started before it attached)
 * the fetch fails / yields an empty result → we surface an empty tree with a
 * hint to relaunch rather than a hard error.
 *
 * `_serial` (the caller's Vega udid) is accepted for call-site symmetry with the
 * iOS/Android describe handlers but not used: the toolkit fetch targets the
 * single running VVD resolved under `fetchVegaPageSource` → `emulatorSerial`.
 * A multi-VVD ambiguity (`MultipleVegaDevicesError`) is rethrown so the guard's
 * "stop all but one VVD" message reaches the caller; every other fetch failure
 * becomes the empty-tree relaunch hint below.
 */
export async function describeVega(_serial: string): Promise<DescribeTreeData> {
  let xml: string;
  try {
    xml = (await fetchVegaPageSource()).trim();
  } catch (err) {
    // A multi-VVD ambiguity is a hard error everywhere — don't bury the guard
    // under the generic relaunch hint (the toolkit isn't the problem here).
    if (err instanceof MultipleVegaDevicesError) throw err;
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
  if (xml.length < PAGE_SOURCE_EMPTY_LENGTH) {
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
  return { tree: parseVegaPageSource(xml), source: "vega-automation" };
}
