import { randomUUID } from "node:crypto";
import { FAILURE_CODES, describeParamIssues, getFailureSignal } from "@argent/registry";
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

/**
 * A nested schema rejection re-rendered against the args the CALLER wrote, or
 * undefined when `err` is not one.
 *
 * Every dispatcher injects the device key into the args it forwards —
 * run-sequence merges `udid` into each step, and the flow runner's
 * `bindDeviceArgs` strips the recorded device keys and re-injects the resolved
 * one. The registry can only describe what it was handed, so its message closes
 * with "You sent: `xx`, `y`, `udid`", naming a key the author never typed
 * (indeed CANNOT have typed: the recorder strips it so flows stay portable)
 * beside the misspelling that list exists to expose. Here is the only place
 * both the dispatched args and the authored ones are in scope.
 *
 * Re-parsing rather than short-circuiting the dispatch: the invoke is what
 * emits `toolInvoked`/`toolFailed` for the step, which the telemetry listener
 * and the event log both subscribe to. Validating up front instead would make
 * an invalid step invisible to both — the very signal a schema miss is now
 * classified to produce. This runs on a failure path only.
 */
export function describeNestedParamError(
  registry: Registry,
  err: unknown,
  toolId: string,
  dispatchedArgs: unknown,
  authoredArgs: unknown
): string | undefined {
  if (getFailureSignal(err)?.error_code !== FAILURE_CODES.TOOL_INPUT_INVALID) return undefined;
  const zodSchema = registry.getTool(toolId)?.zodSchema;
  if (!zodSchema) return undefined;
  // `?? {}` mirrors what the registry parsed, so the issues are the same ones.
  const parsed = zodSchema.safeParse(dispatchedArgs ?? {});
  // Defensive: the rejection came from this parse, so a success here would mean
  // the schema is not a pure function of its input. Leave the original message.
  if (parsed.success) return undefined;
  return `Invalid params for tool "${toolId}": ${describeParamIssues(parsed.error, authoredArgs)}`;
}
