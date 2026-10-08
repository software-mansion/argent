import { randomUUID } from "node:crypto";
import { FAILURE_CODES, describeParamIssues, getFailureSignal } from "@argent/registry";
import type { InvokeToolOptions, Registry, ResolvedFileInput, ToolContext } from "@argent/registry";

/**
 * Dispatch a tool as a child of the current orchestrator invocation.
 *
 * Orchestrators (run-sequence, flow-execute, flow-add-step) call
 * `registry.invokeTool` directly, which would emit each step's lifecycle events
 * under a fresh, unrecorded invocation id — losing the AI-client / platform
 * attribution the HTTP layer captured for the outer request, so nested gestures
 * are recorded as anonymous. When `ctx.recordChildInvocation` is present, mint
 * and register an id (inheriting the outer AI client, platform re-derived from
 * this sub-tool's own `args`), and forward the recorder so propagation survives
 * further nesting (e.g. flow-execute → run-sequence → gesture-tap). With nothing
 * to propagate this is a pass-through.
 *
 * The abort `signal` is forwarded on both paths so a client disconnect cancels a
 * sub-tool that would otherwise poll on to its own timeout, and so is
 * `flowStack`, the chain of enclosing flow runs a nested `flow-execute` checks
 * itself against. `extra` is what a dispatcher decided for this one call, and
 * a key in it wins over the same key of `ctx`: `fileInputs`, the outcome of
 * the file boundary it applied to `args` itself (a `tool:` step whose files
 * are on the client), forwarded as an HTTP call forwards it; `clientServices`,
 * the channel of the outer call, which only a nested `flow-execute` that reads
 * its flow from the client gets; and `flowStack`. `ctx.clientServices` and
 * `ctx.linked` are never forwarded on their own: a sub-tool call is not an
 * HTTP call.
 */
export async function invokeSubTool<T = unknown>(
  registry: Registry,
  ctx: ToolContext | undefined,
  toolId: string,
  args: unknown,
  extra?: {
    fileInputs?: Record<string, ResolvedFileInput>;
    clientServices?: ToolContext["clientServices"];
    flowStack?: InvokeToolOptions["flowStack"];
  }
): Promise<T> {
  const signal = ctx?.signal;
  const recordChildInvocation = ctx?.recordChildInvocation;
  const flowStack = extra?.flowStack ?? ctx?.flowStack;
  const forwarded = {
    ...(extra?.fileInputs ? { fileInputs: extra.fileInputs } : {}),
    ...(extra?.clientServices ? { clientServices: extra.clientServices } : {}),
    ...(flowStack ? { flowStack } : {}),
  };
  if (!recordChildInvocation) {
    return signal || Object.keys(forwarded).length > 0
      ? registry.invokeTool<T>(toolId, args, { ...(signal ? { signal } : {}), ...forwarded })
      : registry.invokeTool<T>(toolId, args);
  }

  const toolInvocationId = randomUUID();
  const release = recordChildInvocation(toolInvocationId, args);
  try {
    return await registry.invokeTool<T>(toolId, args, {
      signal,
      toolInvocationId,
      recordChildInvocation,
      ...forwarded,
    });
  } finally {
    release();
  }
}

/**
 * Dispatchers rewrite the args they forward, and the registry can only
 * describe what it was handed.
 *
 * Re-parsing rather than pre-flighting the dispatch: the invoke is what emits
 * `toolInvoked`/`toolFailed`, so validating up front would make an invalid step
 * invisible to telemetry and the event log.
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
  // Not defensive: `InvalidToolInputError` defaults to `TOOL_INPUT_INVALID`, so
  // a tool that rejects its own arguments inside `execute` passes the gate above
  // with args that parsed fine. Its own message is already right.
  if (parsed.success) return undefined;
  return `Invalid params for tool "${toolId}": ${describeParamIssues(parsed.error, authoredArgs)}`;
}
