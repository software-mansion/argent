import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { variantProposalStore } from "../../utils/variant-proposals";

const zodSchema = z.object({
  timeoutSeconds: z
    .number()
    .int()
    .min(5)
    .max(86_400)
    .optional()
    .describe(
      "Max seconds to block this call before returning a re-awaitable { status: 'pending' } " +
        "result (default 1800). The user's proposals stay live across timeouts — on 'pending' " +
        "just call await_user_selection again. Lower this if your MCP client enforces a short " +
        "request timeout."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const awaitUserSelectionTool: ToolDefinition<Params> = {
  id: "await_user_selection",
  featureFlag: "argent-lens",
  description: `Block until the human finishes picking among the variants you proposed (the ONE blocking call).

Call this exactly once, AFTER you have staged every variant for every element via \`propose_variant\`.
It parks until the user presses "Complete selection" in the Argent Lens window (a native window
that opens automatically on the user's screen), then returns their choices and any comments.

Returns one of:
  • { status: "completed", selections: [{ element, chosenVariant, comment? }], unselected,
      annotations: [{ target, match, comment }], globalComment }
        — the user is done; apply chosenVariant for each element (skip ones in \`unselected\`).
        \`annotations\` are free-form comments the user pinned to specific on-screen elements via
        the inspector — treat each as a change request for that element.
  • { status: "pending", message, proposedElements } — timeoutSeconds elapsed with no submission.
        Expected, not an error: the proposals are still live; call await_user_selection AGAIN.
  • { status: "no_proposals" } — you called this before propose_variant.

This tool is long-running; it intentionally holds the request open. It honors client
disconnects (aborts cleanly).`,
  searchHint: "await wait user selection choice variant blocking confirm picks complete",
  longRunning: true,
  zodSchema,
  services: () => ({}),
  async execute(_services, params, options) {
    const timeoutMs = (params.timeoutSeconds ?? 1800) * 1000;
    return variantProposalStore.awaitSelection({
      signal: options?.signal,
      timeoutMs,
    });
  },
};
