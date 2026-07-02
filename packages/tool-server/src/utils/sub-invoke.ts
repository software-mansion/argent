import { randomUUID } from "node:crypto";
import type { Registry, ToolContext } from "@argent/registry";

/**
 * Dispatch a tool as a child of the current orchestrator invocation.
 *
 * run-sequence / flow-execute / flow-add-step run their steps by calling
 * `registry.invokeTool` directly. Each such call would otherwise emit its
 * lifecycle events under a fresh, unrecorded invocation id — so the AI-client /
 * platform attribution the HTTP layer captured for the outer request never
 * reaches the nested gestures, and they're recorded as anonymous.
 *
 * When the outer request carried attribution, `ctx.recordChildInvocation` is
 * present: mint an id, register it (inheriting the outer AI client, with the
 * platform re-derived from this sub-tool's own `args`), invoke with that id, and
 * release afterwards. We also forward the recorder so propagation survives
 * further nesting (e.g. flow-execute → run-sequence → gesture-tap).
 *
 * When there is nothing to propagate (direct invocations, unit tests, or a
 * request with no AI-client / platform context), this is a thin pass-through
 * that invokes exactly as before.
 *
 * The outer request's abort `signal` is always forwarded (both paths) so a
 * client disconnect cancels a long-running sub-tool — e.g. an await-ui-element
 * step blocking on a UI condition — instead of letting it poll on to its own
 * timeout.
 */
export async function invokeSubTool<T = unknown>(
  registry: Registry,
  ctx: ToolContext | undefined,
  toolId: string,
  args: unknown
): Promise<T> {
  const signal = ctx?.signal;
  const recordChildInvocation = ctx?.recordChildInvocation;
  if (!recordChildInvocation) {
    // No attribution to propagate — invoke exactly as before, but still forward
    // the abort signal when one is present so cancellation reaches the sub-tool.
    return signal
      ? registry.invokeTool<T>(toolId, args, { signal })
      : registry.invokeTool<T>(toolId, args);
  }

  const toolInvocationId = randomUUID();
  const release = recordChildInvocation(toolInvocationId, args);
  try {
    return await registry.invokeTool<T>(toolId, args, {
      signal,
      toolInvocationId,
      recordChildInvocation,
    });
  } finally {
    release();
  }
}
