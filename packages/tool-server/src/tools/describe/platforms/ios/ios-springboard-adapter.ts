import type { CoreDeviceHomescreen } from "../../../../blueprints/core-device";
import { parseDescribeResult, type DescribeNode } from "../../contract";

/**
 * Adapts a physical iPhone's SpringBoard icon state (from CoreDevice's
 * `springboardservices`) into a describe tree for the **home screen**.
 *
 * This is the only app-free *structured* screen data reachable on a real device
 * (in-app accessibility is Apple-gated — see index.ts). It describes what apps
 * exist and roughly where their icons sit; the exact pixel positions of icons
 * are not exposed by SpringBoard, so frames are computed from the icon-grid
 * geometry (`getHomeScreenIconMetrics`) and are APPROXIMATE. The tool's hint
 * tells the agent to confirm with `screenshot` before a precise tap.
 *
 * `iconState` shape (SpringBoard `getIconState`, format 2):
 *   [ dock:[icon…], page0:[item…], page1:[item…], … ]
 * where a leaf icon is `{displayName, bundleIdentifier, …}` and a widget/folder
 * is `{iconType, gridSize:{…}, iconLists|elements, …}` (no displayName).
 */

interface Metrics {
  cols: number;
  rows: number;
}

function readMetrics(m: Record<string, number>): Metrics {
  const cols = Math.round(m.homeScreenIconColumns ?? 4);
  const rows = Math.round(m.homeScreenIconRows ?? 6);
  return {
    cols: cols > 0 ? cols : 4,
    rows: rows > 0 ? rows : 6,
  };
}

interface IconRecord {
  displayName?: unknown;
  bundleIdentifier?: unknown;
  displayIdentifier?: unknown;
  // A widget's footprint is a *string* size class ("small"/"medium"/"large"),
  // not a {columns,rows} pair.
  gridSize?: unknown;
  [k: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isLeaf(item: IconRecord): boolean {
  return str(item.displayName) !== undefined || str(item.bundleIdentifier) !== undefined;
}

/**
 * Cell footprint (columns × rows) an item occupies. Leaves are 1×1; a widget's
 * `gridSize` is an iOS size class — "small" is 2×2, "medium" 4×2, "large" 4×4
 * (an extra-large 4×6 also exists). Anything unrecognised falls back to 1×1.
 */
function span(item: IconRecord): { w: number; h: number } {
  switch (str(item.gridSize)) {
    case "small":
      return { w: 2, h: 2 };
    case "medium":
      return { w: 4, h: 2 };
    case "large":
      return { w: 4, h: 4 };
    case "extralarge":
      return { w: 4, h: 6 };
    default:
      return { w: 1, h: 1 };
  }
}

/** Clamp to the unit interval so an approximate frame never fails validation. */
function unit(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// The home-screen content band, calibrated (iPhone 15, 393×852pt) so a tap at a
// frame's centre lands on the icon: the grid starts just below the status bar
// and a row is ~0.115 of the height. SpringBoard doesn't publish exact insets,
// so these are approximate — good enough to hit the right icon on common iPhone
// sizes, which is all `describe` promises here (the hint says confirm with
// screenshot). The dock sits on its own row near the bottom.
const GRID_TOP = 0.085;
const GRID_ROW_PITCH = 0.115;
const GRID_MARGIN_X = 0.06;

/**
 * Normalized frame for a grid block at (col,row) spanning (w,h) cells. A 1×1
 * icon fills ~70%×50% of its cell (centred); a multi-cell widget fills its
 * whole block so its bounding box reads true.
 */
function gridFrame(
  col: number,
  row: number,
  w: number,
  h: number,
  cols: number
): DescribeNode["frame"] {
  const cellW = (1 - 2 * GRID_MARGIN_X) / cols;
  const cellH = GRID_ROW_PITCH;
  const blockX = GRID_MARGIN_X + col * cellW;
  const blockY = GRID_TOP + row * cellH;
  const blockW = w * cellW;
  const blockH = h * cellH;
  if (w === 1 && h === 1) {
    const fw = blockW * 0.7;
    const fh = blockH * 0.5;
    return {
      x: unit(blockX + (blockW - fw) / 2),
      y: unit(blockY + (blockH - fh) / 2),
      width: unit(fw),
      height: unit(fh),
    };
  }
  return { x: unit(blockX), y: unit(blockY), width: unit(blockW), height: unit(blockH) };
}

/**
 * SpringBoard packs a page row-major, first-fit: each item takes the earliest
 * top-left cell where its w×h block is free. Track a boolean occupancy grid and
 * return each item's placed (col,row) so multi-row widgets don't shove the icons
 * after them into the wrong slots.
 */
class GridPacker {
  private readonly occ: boolean[];
  constructor(
    private readonly cols: number,
    private readonly rows: number
  ) {
    this.occ = new Array(cols * rows).fill(false);
  }
  private free(col: number, row: number, w: number, h: number): boolean {
    if (col + w > this.cols || row + h > this.rows) return false;
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        if (this.occ[r * this.cols + c]) return false;
      }
    }
    return true;
  }
  /** Place a w×h block; returns its top-left (col,row), or null if the page is full. */
  place(w: number, h: number): { col: number; row: number } | null {
    const cw = Math.min(w, this.cols);
    const ch = Math.min(h, this.rows);
    for (let row = 0; row + ch <= this.rows; row++) {
      for (let col = 0; col + cw <= this.cols; col++) {
        if (this.free(col, row, cw, ch)) {
          for (let r = row; r < row + ch; r++) {
            for (let c = col; c < col + cw; c++) this.occ[r * this.cols + c] = true;
          }
          return { col, row };
        }
      }
    }
    return null;
  }
}

/** Frame for the i-th of `count` dock slots along the bottom row. */
function dockFrame(i: number, count: number): DescribeNode["frame"] {
  const n = Math.max(count, 1);
  const marginX = 0.06;
  const slot = (1 - 2 * marginX) / n;
  const cx = marginX + (i + 0.5) * slot;
  const w = slot * 0.6;
  const h = 0.05;
  const cy = 0.945;
  return { x: unit(cx - w / 2), y: unit(cy - h / 2), width: unit(w), height: unit(h) };
}

function iconNode(item: IconRecord, frame: DescribeNode["frame"], role: string): DescribeNode {
  const node: DescribeNode = { role, frame, children: [] };
  const label = str(item.displayName);
  if (label) node.label = label;
  const id = str(item.bundleIdentifier) ?? str(item.displayIdentifier);
  if (id) node.identifier = id;
  return node;
}

/**
 * Build the home-screen describe tree: the first home page's icons laid out on
 * the grid, plus the dock. Later pages aren't on screen, so they're omitted
 * (the agent swipes to reach them, then re-describes).
 */
export function adaptSpringboardToDescribeResult(home: CoreDeviceHomescreen): DescribeNode {
  const { cols, rows } = readMetrics(home.metrics);
  const pages = Array.isArray(home.iconState) ? (home.iconState as IconRecord[][]) : [];
  const children: DescribeNode[] = [];

  // iconState[0] is the dock; iconState[1] is the first home page.
  const dock = Array.isArray(pages[0]) ? pages[0] : [];
  const firstPage = Array.isArray(pages[1]) ? pages[1] : [];

  // First home page — pack items row-major first-fit (SpringBoard's own order),
  // so multi-row widgets don't shove the icons after them into the wrong slots.
  const packer = new GridPacker(cols, rows);
  for (const item of firstPage) {
    if (!item || typeof item !== "object") continue;
    const { w, h } = span(item);
    const pos = packer.place(w, h);
    if (!pos) continue; // page is full
    const frame = gridFrame(pos.col, pos.row, Math.min(w, cols), Math.min(h, rows), cols);
    if (isLeaf(item)) {
      children.push(iconNode(item, frame, "AXIcon"));
    } else {
      // A widget or folder: surface it as a group with any nested leaf icons.
      const group = iconNode(item, frame, "AXGroup");
      for (const leaf of collectNested(item)) group.children.push(iconNode(leaf, frame, "AXIcon"));
      children.push(group);
    }
  }

  // Dock along the bottom.
  dock.forEach((item, i) => {
    if (item && typeof item === "object") {
      children.push(iconNode(item, dockFrame(i, dock.length), "AXIcon"));
    }
  });

  return parseDescribeResult({
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children,
  });
}

/** Pull leaf icons out of a folder/widget's nested `iconLists`. */
function collectNested(item: IconRecord): IconRecord[] {
  const out: IconRecord[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const el of v) visit(el);
    } else if (v && typeof v === "object") {
      const rec = v as IconRecord;
      if (isLeaf(rec)) out.push(rec);
      else if (Array.isArray(rec.iconLists)) visit(rec.iconLists);
    }
  };
  if (Array.isArray(item.iconLists)) visit(item.iconLists);
  return out;
}
