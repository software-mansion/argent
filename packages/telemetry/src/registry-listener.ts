import { FAILURE_CODES, getFailureSignalOrFallback, type Registry } from "@argent/registry";
import { track } from "./index.js";
import { aiTelemetryFromMeta, type AiTelemetryProps } from "./ai-identity.js";

// HTTP captures request-only metadata here so registry lifecycle events can
// include platform context (and the coarse AI client) without carrying raw params.
export interface InvocationMeta extends AiTelemetryProps {
  platform?: "ios" | "android";
}

interface AttachHandle {
  /** Idempotent unsubscribe. */
  detach: () => void;
  /** Register metadata for a known invocation id. */
  recordInvocation: (toolInvocationId: string, meta: InvocationMeta) => () => void;
  /** Counter exposed for the `toolserver:stop` payload. */
  getTotalToolCalls: () => number;
}

export function attachRegistryTelemetry(registry: Registry): AttachHandle {
  const activeMetaByInvocationId = new Map<string, InvocationMeta>();
  let totalToolCalls = 0;

  function consumeActiveMeta(toolInvocationId: string): InvocationMeta {
    const meta = activeMetaByInvocationId.get(toolInvocationId);
    if (meta) activeMetaByInvocationId.delete(toolInvocationId);
    return meta ?? {};
  }

  const onInvoked = (toolId: string, toolInvocationId: string): void => {
    totalToolCalls += 1;
    const meta = activeMetaByInvocationId.get(toolInvocationId) ?? {};
    track("tool:invoke", {
      tool: toolId,
      tool_invocation_id: toolInvocationId,
      ...(meta.platform ? { platform: meta.platform } : {}),
      ...aiTelemetryFromMeta(meta),
    });
  };

  const onCompleted = (toolId: string, toolInvocationId: string, durationMs: number): void => {
    const meta = consumeActiveMeta(toolInvocationId);
    track("tool:complete", {
      tool: toolId,
      tool_invocation_id: toolInvocationId,
      ...(meta.platform ? { platform: meta.platform } : {}),
      duration_ms: durationMs,
      ...aiTelemetryFromMeta(meta),
    });
  };

  const onFailed = (
    toolId: string,
    toolInvocationId: string,
    error: Error,
    durationMs = 0
  ): void => {
    const meta = consumeActiveMeta(toolInvocationId);
    const signal = getFailureSignalOrFallback(error, {
      error_code: FAILURE_CODES.REGISTRY_TOOL_FAILURE_UNCLASSIFIED,
      failure_stage: "registry_tool_failed_event",
      failure_area: "registry",
      error_kind: "unknown",
    });
    track("tool:fail", {
      tool: toolId,
      tool_invocation_id: toolInvocationId,
      ...(meta.platform ? { platform: meta.platform } : {}),
      duration_ms: durationMs,
      ...signal,
      ...aiTelemetryFromMeta(meta),
    });
  };

  registry.events.on("toolInvoked", onInvoked);
  registry.events.on("toolCompleted", onCompleted);
  registry.events.on("toolFailed", onFailed);

  function recordInvocation(toolInvocationId: string, meta: InvocationMeta): () => void {
    activeMetaByInvocationId.set(toolInvocationId, meta);
    return () => {
      if (activeMetaByInvocationId.get(toolInvocationId) === meta) {
        activeMetaByInvocationId.delete(toolInvocationId);
      }
    };
  }

  return {
    detach: () => {
      registry.events.off("toolInvoked", onInvoked);
      registry.events.off("toolCompleted", onCompleted);
      registry.events.off("toolFailed", onFailed);
      activeMetaByInvocationId.clear();
    },
    recordInvocation,
    getTotalToolCalls: () => totalToolCalls,
  };
}
