// Normalized screen model + parser for argent's `describe` text — the single
// contract the grounding + resolver depend on. Works for iOS `AX*` roles and
// Android roles alike.

export interface El {
  role: string;
  label?: string;
  frame: [number, number, number, number]; // x, y, w, h  (normalized, top-left)
  interactive?: boolean;
}

export interface Screen {
  elements: El[];
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function center(e: El): [number, number] {
  const [x, y, w, h] = e.frame;
  return [round4(x + w / 2), round4(y + h / 2)];
}

function norm(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/-/g, "")
    .replace(/[\s,]+/g, " ")
    .trim();
}

// argent describe line (iOS or Android):
//   AXButton "Login" [flags]  (0.350, 0.620, 0.300, 0.060)
//   Button "Login" [clickable]  (0.036, 0.303, 0.929, 0.048)
const LINE =
  /^\s*([A-Za-z][\w.]*)\s+(?:"([^"]*)"\s*)?.*?\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)\s*$/;

export function parseDescribe(text: string): Screen {
  const elements: El[] = [];
  for (const line of (text || "").split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, role, label, x, y, w, h] = m;
    if (!label) continue; // only labeled tap targets
    elements.push({
      role,
      label,
      frame: [parseFloat(x), parseFloat(y), parseFloat(w), parseFloat(h)],
      interactive: true,
    });
  }
  return { elements };
}

export function renderTree(s: Screen): string {
  return s.elements
    .map((e) => {
      const [x, y, w, h] = e.frame;
      return `${e.role} "${e.label}" (${x.toFixed(3)}, ${y.toFixed(3)}, ${w.toFixed(3)}, ${h.toFixed(3)})`;
    })
    .join("\n");
}

export function labels(s: Screen): string[] {
  return s.elements.map((e) => e.label).filter((l): l is string => !!l);
}

// Prefer genuinely tappable roles when a label is ambiguous (an AXButton "Login"
// and an AXStaticText "Login" nav title both match — the button must win).
const ROLE_PRIORITY = [
  "AXButton",
  "AXTextField",
  "AXSecureTextField",
  "AXCell",
  "AXLink",
  "AXSwitch",
  "AXMenuItem",
  "AXTabBar",
  "Button",
  "TextField",
  "EditText",
  "ImageButton",
  "CheckBox",
  "Switch",
  "Link",
  "Cell",
];
function roleRank(role: string): number {
  const i = ROLE_PRIORITY.indexOf(role);
  return i < 0 ? 99 : i;
}

/** Resolve a model-named target (verbatim label) to a tap point, argent-style. */
export function resolveTarget(screen: Screen, target: string): [number, number, string] | null {
  if (!target) return null;
  const quoted = target.match(/"([^"]+)"/);
  const needle = norm(quoted ? quoted[1] : target);
  if (!needle) return null;
  const exact: El[] = [];
  const sub: El[] = [];
  for (const e of screen.elements) {
    const [, , fw, fh] = e.frame;
    if (fw * fh > 0.85) continue; // container guard
    const nl = e.label ? norm(e.label) : "";
    if (nl && nl === needle) exact.push(e);
    else if (nl && (nl.includes(needle) || (needle.includes(nl) && nl.length >= 3))) sub.push(e);
  }
  const pool = exact.length ? exact : sub;
  if (!pool.length) return null;
  pool.sort((a, b) => roleRank(a.role) - roleRank(b.role));
  const [cx, cy] = center(pool[0]);
  return [cx, cy, pool[0].label ?? pool[0].role];
}
