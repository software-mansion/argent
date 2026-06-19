// Exact reproductions of Argent tool output formats. These are ported from the
// real serializers so the model trains on observations identical to production:
//   - describe         -> packages/tool-server/src/tools/describe/format-tree.ts
//   - component-tree    -> packages/tool-server/src/tools/debugger/debugger-component-tree.ts
//   - view-network-logs -> packages/tool-server/src/tools/network/network-logs.ts

import type { ElementDef, Frame, NetworkSeed, Platform, ScreenDef } from "./types.ts";

// Pixel dimensions used to render component-tree screen headers (RN reports raw
// pixel rects; describe reports normalized fractions).
export const SCREEN_PX: Record<Platform, { w: number; h: number }> = {
  ios: { w: 393, h: 852 }, // iPhone 16 Pro logical points
  android: { w: 1080, h: 2400 },
  chromium: { w: 1280, h: 800 },
};

// ---- semantic role -> platform role mapping (mirrors the per-platform adapters) ----

const ROLE_MAP: Record<Platform, Record<string, string>> = {
  ios: {
    button: "AXButton",
    text: "AXStaticText",
    heading: "AXHeading",
    image: "AXImage",
    link: "AXLink",
    field: "AXTextField",
    switch: "AXSwitch",
    tab: "AXButton",
    container: "AXGroup",
    list: "AXGroup",
  },
  android: {
    button: "android.widget.Button",
    text: "android.widget.TextView",
    heading: "android.widget.TextView",
    image: "android.widget.ImageView",
    link: "android.widget.TextView",
    field: "android.widget.EditText",
    switch: "android.widget.Switch",
    tab: "android.widget.Button",
    container: "android.view.ViewGroup",
    list: "androidx.recyclerview.widget.RecyclerView",
  },
  chromium: {
    button: "button",
    text: "StaticText",
    heading: "heading",
    image: "image",
    link: "link",
    field: "textbox",
    switch: "switch",
    tab: "tab",
    container: "generic",
    list: "list",
  },
};

export function describeSource(platform: Platform): string {
  return platform === "ios" ? "ax-service" : platform === "android" ? "uiautomator" : "cdp-dom";
}

function fmtFrame(f: Frame): string {
  return `(${f.x.toFixed(3)}, ${f.y.toFixed(3)}, ${f.w.toFixed(3)}, ${f.h.toFixed(3)})`;
}

function escapeForLine(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

/** Elements currently visible on the screen given scroll state. */
export function visibleElements(screen: ScreenDef, scrolled: boolean): ElementDef[] {
  return screen.elements.filter((e) => (e.revealedByScroll ? scrolled : true));
}

const DESCRIBE_HEADER_NOTE =
  "Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), " +
  "not pixels — pass them straight to gesture-tap / gesture-swipe / gesture-pinch, " +
  "which expect this same space. " +
  "To tap an element, use its centre: tap_x = frame.x + frame.width / 2, " +
  "tap_y = frame.y + frame.height / 2.";

export function formatDescribe(platform: Platform, screen: ScreenDef, scrolled: boolean): string {
  const source = describeSource(platform);
  const mode: "flat" | "nested" = platform === "ios" ? "flat" : "nested";
  const rootRole = platform === "ios" ? "AXGroup" : platform === "android" ? "android.view.ViewGroup" : "RootWebArea";

  const header = [
    `Source: ${source}`,
    `Mode: ${mode}`,
    DESCRIBE_HEADER_NOTE,
    "",
    `ROOT  ${rootRole} (0.000, 0.000, 1.000, 1.000)`,
    "",
  ];

  const els = visibleElements(screen, scrolled)
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);

  const body = els.map((e) => formatDescribeLine(platform, e, 1));
  return [...header, ...body].join("\n").replace(/\n+$/, "\n");
}

function formatDescribeLine(platform: Platform, e: ElementDef, indent: number): string {
  const pad = "  ".repeat(indent);
  const role = ROLE_MAP[platform][e.role] ?? e.role;
  const labelPart = e.label ? `"${escapeForLine(e.label)}"` : "";
  const idPart = e.identifier ? ` id="${escapeForLine(e.identifier)}"` : "";
  const flags = describeFlags(platform, e);
  const annotations = `${labelPart}${idPart}${flags}`.trim();
  const annotated = annotations ? ` ${annotations}` : "";
  return `${pad}${role}${annotated}  ${fmtFrame(e.frame)}`;
}

function describeFlags(platform: Platform, e: ElementDef): string {
  // Android describe surfaces interactivity flags; iOS/Chromium do not.
  if (platform !== "android") return "";
  const flags: string[] = [];
  if (e.navigatesTo || e.role === "button" || e.role === "tab") flags.push("clickable");
  if (e.role === "switch") flags.push(e.togglesState ? "checkable" : "checkable");
  if (e.role === "list") flags.push("scrollable");
  return flags.length ? ` [${flags.join(",")}]` : "";
}

// ---- debugger-component-tree (RN) ----

export function formatComponentTree(platform: Platform, screen: ScreenDef, scrolled: boolean): string {
  const px = SCREEN_PX[platform];
  const lines: string[] = [`Screen: ${px.w}x${px.h}`, ""];
  lines.push(`${screen.title.replace(/\s+/g, "")}Screen`);
  const els = visibleElements(screen, scrolled)
    .slice()
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  for (const e of els) {
    lines.push("  " + componentLabel(e));
  }
  return lines.join("\n");
}

function componentLabel(e: ElementDef): string {
  let label = e.component ?? defaultComponent(e.role);
  const text = e.label;
  if (text) label += ` "${text}"`;
  if (e.identifier) label += ` [testID=${e.identifier}]`;
  const tapX = (e.frame.x + e.frame.w / 2).toFixed(2);
  const tapY = (e.frame.y + e.frame.h / 2).toFixed(2);
  label += ` (tap: ${tapX},${tapY})`;
  return label;
}

function defaultComponent(role: string): string {
  switch (role) {
    case "button":
      return "Pressable";
    case "text":
    case "heading":
    case "link":
      return "Text";
    case "image":
      return "Image";
    case "field":
      return "TextInput";
    case "switch":
      return "Switch";
    case "list":
      return "FlatList";
    default:
      return "View";
  }
}

// ---- view-network-logs ----

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatNetworkLogs(reqs: NetworkSeed[]): string {
  if (reqs.length === 0) {
    return "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active — it captures fetch() calls.";
  }
  const lines = reqs.map((r, i) => {
    let name: string;
    try {
      const parsed = new URL(r.url);
      name = parsed.pathname === "/" ? parsed.hostname : parsed.pathname;
    } catch {
      name = r.url;
    }
    const status = `${r.status} ${r.statusText}`;
    const size = formatBytes(r.bytes);
    return `{id: req_${i + 1}} "${r.method} ${name}" ${status} ${r.resourceType} ${size} ${r.durationMs} ms`.trim();
  });
  return `=== NETWORK LOGS (page 1/1, ${reqs.length} total) ===\n\n${lines.join("\n")}`;
}

/** Centre tap point of an element, in normalized space. */
export function tapPoint(e: ElementDef): { x: number; y: number } {
  return { x: round3(e.frame.x + e.frame.w / 2), y: round3(e.frame.y + e.frame.h / 2) };
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
