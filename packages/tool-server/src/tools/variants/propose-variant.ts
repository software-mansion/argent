import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { variantProposalStore } from "../../utils/variant-proposals";

const zodSchema = z.object({
  element: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Human name of the on-screen element this variant targets, e.g. "Foo button" or ' +
        '"profile header". Repeated calls with the same element accumulate multiple variants ' +
        "on it. Used as the default screen matcher when `match` is omitted."
    ),
  match: z
    .object({
      by: z
        .enum(["text", "label", "identifier", "role"])
        .describe(
          "How the preview window locates the live element in the running app's accessibility tree: " +
            "`text` (fuzzy contains on label/value/identifier), `label` (exact a11y label), " +
            "`identifier` (exact testID / accessibilityIdentifier / resource-id), `role` (e.g. Button)."
        ),
      value: z.string().min(1).describe("Value to match against, per `by`."),
    })
    .optional()
    .describe(
      "Optional precise matcher so the floating variant bubble anchors to the right element on " +
        "the streamed screen. Defaults to { by: 'text', value: element }. Get exact " +
        "labels/identifiers from the `describe` tool first for reliable anchoring."
    ),
  variant: z
    .object({
      name: z
        .string()
        .min(1)
        .max(120)
        .describe('Short variant name shown on the chip, e.g. "Bold CTA".'),
      summary: z
        .string()
        .min(1)
        .max(2_000)
        .describe("One- or two-sentence description of what this variant changes and why."),
      code: z
        .string()
        .max(20_000)
        .optional()
        .describe("Optional inline code/JSX for the variant, shown when the chip is expanded."),
      filePath: z
        .string()
        .max(1_000)
        .optional()
        .describe("Optional path to a file containing the variant implementation."),
      previewImage: z
        .string()
        .max(2_000)
        .optional()
        .describe(
          "Optional preview of how the variant looks, shown on the floating card. An http(s) " +
            "URL, a data: URI, or a local image file path (e.g. a screenshot path returned by " +
            "the screenshot tool after you rendered the variant)."
        ),
      frame: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .optional()
        .describe(
          "Normalized [0..1] bounds (fractions of screen width/height) of the target element AS IT " +
            "APPEARS IN THIS VARIANT — read the matched node's `frame` from `describe` AFTER applying " +
            "this variant. The preview window crops the screenshot to these bounds, so each variant " +
            "shows its own re-laid-out element instead of every variant sharing one stale frame. The " +
            "element moves/resizes between variants, so capture it per variant. Omit if unknown."
        ),
    })
    .describe("The variant being proposed for `element`."),
});

type Params = z.infer<typeof zodSchema>;

export const proposeVariantTool: ToolDefinition<Params> = {
  id: "propose_variant",
  featureFlag: "variant-selection",
  description: `Stage ONE design variant for ONE on-screen element, then return immediately (non-blocking).

Use when you have produced multiple alternative designs for an element and want the human to pick.
Call this once per variant: e.g. propose_variant("Foo", v1), propose_variant("Foo", v2),
propose_variant("Bar", v1)…  Variants accumulate per element and across elements. The agent is NOT
blocked — keep proposing and keep working. Each element appears live in the Argent preview window (a
native window that opens automatically) as a floating card beside the streamed simulator, with a thin
line connecting it to the matched on-screen element; you don't open or display anything yourself. Pass
variant.previewImage (e.g. a screenshot path) to show how each variant looks.

When you have proposed every variant for every element, call \`await_user_selection\` once — that is
the single blocking call that waits for the human's picks.

Returns { round, elementId, variantId, element, variantCount, totalElements } — confirmation only;
it does not wait for the user.`,
  searchHint: "propose design variant alternative option for element non-blocking ab choice",
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const res = variantProposalStore.proposeVariant(params);
    return {
      ...res,
      hint:
        res.variantCount === 1
          ? `Staged the first variant for "${res.element}". Propose more variants (for this or ` +
            `other elements), then call await_user_selection once when done.`
          : `"${res.element}" now has ${res.variantCount} variants. Keep proposing or call ` +
            `await_user_selection when every element is covered.`,
    };
  },
};
