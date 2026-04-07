import { z } from "zod";

export const nativeDescribeRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

export const nativeDescribePointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const nativeDescribeElementSchema = z
  .object({
    frame: nativeDescribeRectSchema,
    tapPoint: nativeDescribePointSchema,
    normalizedFrame: nativeDescribeRectSchema,
    normalizedTapPoint: nativeDescribePointSchema,
    traits: z.array(z.string()),
    label: z.string().optional(),
    hint: z.string().optional(),
    value: z.string().optional(),
    identifier: z.string().optional(),
    viewClassName: z.string().optional(),
  })
  .passthrough();

export const nativeDescribeScreenResultSchema = z
  .object({
    screenFrame: nativeDescribeRectSchema,
    elements: z.array(nativeDescribeElementSchema),
  })
  .passthrough();

export type NativeDescribeRect = z.infer<typeof nativeDescribeRectSchema>;
export type NativeDescribePoint = z.infer<typeof nativeDescribePointSchema>;
export type NativeDescribeElement = z.infer<typeof nativeDescribeElementSchema>;
export type NativeDescribeScreenResult = z.infer<typeof nativeDescribeScreenResultSchema>;

export function parseNativeDescribeScreenResult(input: unknown): NativeDescribeScreenResult {
  return nativeDescribeScreenResultSchema.parse(input);
}
