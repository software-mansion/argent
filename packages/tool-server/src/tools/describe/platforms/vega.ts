import type { ToolDependency } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../contract";
import { fetchVegaPageSource } from "../../../utils/vega-inspect";
import { MultipleVegaDevicesError } from "../../../utils/vega-vvd";
import { parseVegaPageSource } from "./vega/source-parser";

// `describeVega` runs entirely over `adb` (`fetchVegaPageSource` → `adb forward`
// + inspect) and never touches the `vega`/`kepler` CLI, so preflight on `adb`
// (like the Android branch) — not `vega`. A running VVD with an unsourced
// `~/vega/env` can still be described over adb.
export const vegaRequires: ToolDependency[] = ["adb"];

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
 * Describe the current Vega screen from the on-device automation toolkit's
 * `getPageSource` XML (fetched over `adb forward`). An unreachable toolkit yields
 * an empty tree + relaunch hint; a multi-VVD ambiguity is rethrown. `_serial` is
 * unused — the fetch targets the single running VVD.
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
  // A non-empty but malformed/truncated page source (e.g. a toolkit HTTP error
  // body that slips past the length check) must degrade to the same empty-tree +
  // relaunch hint rather than escaping as a raw parse error.
  try {
    return { tree: parseVegaPageSource(xml), source: "vega-automation" };
  } catch {
    return { tree: EMPTY_TREE, source: "vega-automation", hint: UNAVAILABLE_HINT };
  }
}
