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
    })
    .passthrough()
);

export interface DescribeResult {
  // Pretty-printed text outline of the visible accessibility tree, one node
  // per line in the form `Role [x,y wxh] label='…' id='…' value='…'`.
  // Returning text rather than a JSON DescribeNode tree keeps the agent's
  // tool-result legible: the prior nested-JSON shape required scrolling past
  // ~10 layout-wrapper levels to find the actual tap targets, and the noise
  // dwarfed the signal on Android. Layout-only containers and decorative
  // leaves are filtered out by `formatDescribeTreeAsText` before rendering.
  tree: string;
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
