import { z } from "zod";

export const describeFrameSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0).max(1),
  height: z.number().finite().min(0).max(1),
});

export type DescribeFrame = z.infer<typeof describeFrameSchema>;

export interface DescribeNode {
  role: string;
  frame: DescribeFrame;
  children: DescribeNode[];
  label?: string;
  identifier?: string;
  value?: string;
  // Interactivity flags surfaced by the Android uiautomator dump. iOS
  // consumers leave these unset; adding them as optional avoids breaking
  // existing payloads. `scrollHidden` counts children that fell outside an
  // ancestor scroll's clip rect — the agent should swipe before tapping.
  clickable?: boolean;
  longClickable?: boolean;
  scrollable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  disabled?: boolean;
  password?: boolean;
  scrollHidden?: number;
}

export const describeNodeSchema: z.ZodType<DescribeNode> = z.lazy(() =>
  z
    .object({
      role: z.string().min(1),
      frame: describeFrameSchema,
      children: z.array(describeNodeSchema),
      label: z.string().optional(),
      identifier: z.string().optional(),
      value: z.string().optional(),
      clickable: z.boolean().optional(),
      longClickable: z.boolean().optional(),
      scrollable: z.boolean().optional(),
      checkable: z.boolean().optional(),
      checked: z.boolean().optional(),
      disabled: z.boolean().optional(),
      password: z.boolean().optional(),
      scrollHidden: z.number().int().nonnegative().optional(),
    })
    .passthrough()
);

// Internal shape produced by the per-platform adapters. The `tree` is consumed
// by the formatter in `format-tree.ts` and then dropped before the tool replies
// — callers see `DescribeResult` below, which surfaces only the rendered text.
export interface DescribeTreeData {
  tree: DescribeNode;
  source: "ax-service" | "native-devtools" | "uiautomator";
  should_restart?: boolean;
}

// Public describe-tool response. The full JSON `tree` (the previous payload's
// biggest cost — ~6× the byte size of the formatted rendering on a typical iOS
// screen) is no longer surfaced; `description` is a text rendering produced by
// `format-tree.ts` that preserves every label, role, and frame the agent needs
// for taps.
export interface DescribeResult {
  description: string;
  // "ax-service" / "native-devtools" come from iOS; "uiautomator" is the
  // Android branch's underlying provider. Agents that branch on `source`
  // (e.g. to decide whether to also call `native-find-views` for a richer
  // tree) need to distinguish the Android case from an iOS native-devtools
  // fallback — which the previous shared label hid.
  source: "ax-service" | "native-devtools" | "uiautomator";
  should_restart?: boolean;
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
