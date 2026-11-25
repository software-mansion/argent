import { z } from "zod";

const describeFrameSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0).max(1),
  height: z.number().finite().min(0).max(1),
});

export type DescribeFrame = z.infer<typeof describeFrameSchema>;

const describePointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

type DescribePoint = z.infer<typeof describePointSchema>;

export interface DescribeNode {
  role: string;
  frame: DescribeFrame;
  children: DescribeNode[];
  label?: string;
  // The element's VoiceOver hint (iOS simulator). Not the same thing as the
  // result-level `hint` on DescribeTreeData, which is a note about the read.
  hint?: string;
  identifier?: string;
  value?: string;
  // Descendant text hoisted onto container leaves by the flow adapters'
  // flatten (`flow-tree-flatten`): the flat shape drops the child that renders
  // the text, so a flow `text` condition reads this for a testID container.
  // The describe tool leaves it unset; the tree the await tools judge on a Mac
  // app carries the flow tree's value.
  subtreeText?: string;
  // `value` is the text a text field holds, typed or set by the app, not the
  // placeholder of an empty field. A selector does not match the field by this
  // text, except a `type` step's `into`. Set by the iOS simulator flow adapter
  // only; the describe tool leaves it unset.
  typedValue?: boolean;
  clickable?: boolean;
  longClickable?: boolean;
  scrollable?: boolean;
  // A scroll container's content window: `frame` less borders and scrollbars,
  // where the source measures it (Chromium). Its content is clipped to this.
  clipFrame?: DescribeFrame;
  // Where scroll containers cut the element by more than a pixel (Chromium): the
  // part of their window the clips above them leave showing, along each axis they
  // cut it, and the whole screen along the other.
  clipBounds?: DescribeFrame;
  // Per axis a scroll container cuts the element along, where a wheel scrolls it
  // against that scroller: a point hit-tested on screen, else the window's centre.
  clipAnchors?: { x?: DescribePoint; y?: DescribePoint };
  checkable?: boolean;
  checked?: boolean;
  disabled?: boolean;
  password?: boolean;
  // Children dropped for falling fully outside an ancestor scroll's clip rect
  // — the agent should swipe before tapping.
  scrollHidden?: number;
  // Distinct on D-pad UIs: input focus vs. the visually highlighted item.
  focused?: boolean;
  selected?: boolean;
  // A Mac app's stacking: 1 in a sheet, alert or popover, one more in each one
  // attached over it, highest in an open menu, absent in a window. Of a
  // selector's matches, the frontmost layer wins.
  layer?: number;
  // An element of the on-screen keyboard: a key, the prediction bar, a button
  // or field of the keyboard. An e2e action takes an app element before it, and
  // the e2e conditions do not see it. Set by the e2e runner's tree adapters only; the
  // describe tool leaves it unset.
  keyboard?: boolean;
}

export const describeNodeSchema: z.ZodType<DescribeNode> = z.lazy(() =>
  z
    .object({
      role: z.string().min(1),
      frame: describeFrameSchema,
      children: z.array(describeNodeSchema),
      label: z.string().optional(),
      hint: z.string().optional(),
      identifier: z.string().optional(),
      value: z.string().optional(),
      subtreeText: z.string().optional(),
      typedValue: z.boolean().optional(),
      clickable: z.boolean().optional(),
      longClickable: z.boolean().optional(),
      scrollable: z.boolean().optional(),
      clipFrame: describeFrameSchema.optional(),
      clipBounds: describeFrameSchema.optional(),
      clipAnchors: z
        .object({ x: describePointSchema.optional(), y: describePointSchema.optional() })
        .optional(),
      checkable: z.boolean().optional(),
      checked: z.boolean().optional(),
      disabled: z.boolean().optional(),
      password: z.boolean().optional(),
      scrollHidden: z.number().int().nonnegative().optional(),
      focused: z.boolean().optional(),
      selected: z.boolean().optional(),
      layer: z.number().int().nonnegative().optional(),
      keyboard: z.boolean().optional(),
    })
    .passthrough()
);

// Where the tree came from. "ax-service" / "native-devtools": iOS.
// "uiautomator" / "android-devtools": Android. "cdp-dom": the Chromium DOM walk
// over Chrome DevTools Protocol. "vega-automation": the Vega on-device
// automation toolkit. "harmony-uitest": the HarmonyOS device's own `uitest
// dumpLayout`. "tv-focus": the focus-driven view for a TV target (Apple TV /
// Android TV), which reports focused / focusable elements rather than a
// tap-oriented tree.
export type DescribeSource =
  | "ax-service"
  | "native-devtools"
  | "uiautomator"
  | "android-devtools"
  | "cdp-dom"
  | "vega-automation"
  | "harmony-uitest"
  | "tv-focus"
  // Physical iOS: the XCUITest runner accessibility snapshot.
  | "xcuitest-runner"
  // A native Mac app: the in-app library's tree, and the one it reads while the
  // Mac is locked.
  | "macos-devtools"
  | "macos-fallback";

// Adapter-internal: `tree` is rendered by `format-tree.ts` and then dropped —
// callers get `DescribeResult` below, i.e. only the rendered text.
export interface DescribeTreeData {
  tree: DescribeNode;
  source: DescribeSource;
  should_restart?: boolean;
  // "degraded" means boot-state on the simulator path and a truncated snapshot on the device path.
  // Each path writes this hint once.
  hint?: string;
  // Possibly not the live screen (a suspended HarmonyOS panel); `hint` says why.
  stale?: boolean;
  // Part of the screen was not read (an Apple TV hierarchy cut at its node cap),
  // so an element's absence proves nothing; `hint` says why.
  partial?: boolean;
  // Size the frames were normalized against, in the source's native units
  // (Android px, iOS pt), so only the aspect ratio compares across sources —
  // which is what the rotate directive's circle geometry reads it for. Set
  // only by the flow tree adapters that know it.
  screen?: { width: number; height: number };
  // `tree` as a result may quote it, node for node, from the iOS simulator
  // adapter once a secret was typed on the device: the text of each text input
  // withheld, each typed value in a label named by its placeholder (see
  // `utils/typed-secrets`). Checks read `tree`; only a quote reads this.
  quotableTree?: DescribeNode;
  // The source cut its walk short (a node, depth or time cap): what it found is
  // real, but an element past the cut reads as absent. Set by the iOS
  // simulator flow tree.
  truncated?: boolean;
  // What may hide a selector's target from `tree`, for the wording of a miss
  // only: never matched, never quoted. Set by the iOS simulator and Android
  // flow trees (see `FlowCover`).
  cover?: FlowCover;
}

/**
 * Why elements below a cover are not in a flow tree.
 *
 * `covered` (iOS simulator): the accessibility service marks what an alert,
 * sheet or popover covers, and the app below a system alert. `leaves` are
 * those elements, flattened as the flow tree flattens its own; `systemAlert` is
 * the read's `alertVisible`. Absent when nothing is covered.
 *
 * `window` (Android): Android leaves the app's window out of the tree while
 * one of these windows is on top. The topmost application window, when it is
 * a system dialog or sheet (`system`, the test `alertVisible` uses) or a
 * window that starts below the top. Absent otherwise.
 */
export type FlowCover =
  | { kind: "covered"; leaves: DescribeNode[]; systemAlert: boolean }
  | { kind: "window"; system: boolean; package: string };

/** Interface orientation as UIKit names it, relative to the portrait-native screen. */
export type UiOrientation = "portrait" | "landscapeLeft" | "landscapeRight" | "portraitUpsideDown";

const UI_ORIENTATIONS: readonly UiOrientation[] = [
  "portrait",
  "portraitUpsideDown",
  "landscapeLeft",
  "landscapeRight",
];

export function asUiOrientation(v: unknown): UiOrientation | undefined {
  return typeof v === "string" && (UI_ORIENTATIONS as readonly string[]).includes(v)
    ? (v as UiOrientation)
    : undefined;
}

export interface DescribeResult {
  description: string;
  source: DescribeSource;
  should_restart?: boolean;
  hint?: string;
}

export function parseDescribeResult(input: unknown): DescribeNode {
  return describeNodeSchema.parse(input);
}

export function getDescribeTapPoint(frame: DescribeFrame): { x: number; y: number } {
  return {
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}
