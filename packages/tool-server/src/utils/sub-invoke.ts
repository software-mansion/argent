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
 */
export async function invokeSubTool<T = unknown>(
  registry: Registry,
  ctx: ToolContext | undefined,
  toolId: string,
  args: unknown
): Promise<T> {
  // Forward the outer request's abort signal so a cancelled/disconnected client
  // stops an in-flight sub-step too — not just the gap between steps. An
  // orchestrator like run-sequence is `longRunning` and a single step (e.g. a
  // long `tv-remote` path) can run for minutes; without this the sub-tool's own
  // `options.signal.throwIfAborted()` is a no-op and the step runs to completion
  // at the held device after the caller is gone.
  const signal = ctx?.signal;
  const recordChildInvocation = ctx?.recordChildInvocation;
  if (!recordChildInvocation) {
    // Nothing to attribute — pass through. Only attach options when there's a
    // signal to forward, so the no-context case stays a plain 2-arg invoke.
    return signal
      ? registry.invokeTool<T>(toolId, args, { signal })
      : registry.invokeTool<T>(toolId, args);
  }

  const toolInvocationId = randomUUID();
  const release = recordChildInvocation(toolInvocationId, args);
  try {
    return await registry.invokeTool<T>(toolId, args, {
      ...(signal ? { signal } : {}),
      toolInvocationId,
      recordChildInvocation,
    });
  } finally {
    release();
  }
}
