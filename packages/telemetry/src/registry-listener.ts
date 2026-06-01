import type { Registry } from "@argent/registry";
import { track } from "./index.js";
import { hashId } from "./hash.js";

// HTTP captures request-only metadata here so registry lifecycle events can
// include platform/device context without carrying raw params.
export interface InvocationMeta {
  platform?: "ios" | "android";
  deviceId?: string;
}

interface AttachHandle {
  /** Idempotent unsubscribe. */
  detach: () => void;
  /** Register metadata for the next invocation of this tool id. */
  recordInvocation: (toolId: string, meta: InvocationMeta) => () => void;
  /** Counter exposed for the `toolserver:stop` payload. */
  getTotalToolCalls: () => number;
}

export function attachRegistryTelemetry(registry: Registry): AttachHandle {
  const pendingMetaByTool = new Map<string, InvocationMeta[]>();
  const activeMetaByInvocationId = new Map<string, InvocationMeta>();
  let totalToolCalls = 0;

  function consumePendingMeta(toolId: string): InvocationMeta {
    const queue = pendingMetaByTool.get(toolId);
    const meta = queue?.shift();
    if (queue && queue.length === 0) pendingMetaByTool.delete(toolId);
    return meta ?? {};
  }

  function consumeActiveMeta(toolInvocationId: string): InvocationMeta {
    const meta = activeMetaByInvocationId.get(toolInvocationId);
    if (meta) activeMetaByInvocationId.delete(toolInvocationId);
    return meta ?? {};
  }

  const onInvoked = (toolId: string, toolInvocationId: string): void => {
    totalToolCalls += 1;
    const meta = consumePendingMeta(toolId);
    activeMetaByInvocationId.set(toolInvocationId, meta);
    track("tool:invoke", {
      tool: toolId,
      tool_invocation_id: toolInvocationId,
      ...(meta.platform ? { platform: meta.platform } : {}),
      ...(meta.deviceId ? { device_id_hash: hashId(meta.deviceId) } : {}),
    });
  };

  const onCompleted = (toolId: string, toolInvocationId: string, durationMs: number): void => {
    const meta = consumeActiveMeta(toolInvocationId);
    track("tool:complete", {
      tool: toolId,
      tool_invocation_id: toolInvocationId,
      ...(meta.platform ? { platform: meta.platform } : {}),
      duration_ms: durationMs,
    });
  };

  const onFailed = (
    toolId: string,
    toolInvocationId: string,
    error: Error,
    durationMs = 0
  ): void => {
    const meta = consumeActiveMeta(toolInvocationId);
    track("tool:fail", {
      tool: toolId,
      tool_invocation_id: toolInvocationId,
      ...(meta.platform ? { platform: meta.platform } : {}),
      duration_ms: durationMs,
    });
  };

  registry.events.on("toolInvoked", onInvoked);
  registry.events.on("toolCompleted", onCompleted);
  registry.events.on("toolFailed", onFailed);

  function recordInvocation(toolId: string, meta: InvocationMeta): () => void {
    const queue = pendingMetaByTool.get(toolId) ?? [];
    queue.push(meta);
    pendingMetaByTool.set(toolId, queue);
    return () => {
      const current = pendingMetaByTool.get(toolId);
      if (!current) return;
      const index = current.indexOf(meta);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) pendingMetaByTool.delete(toolId);
    };
  }

  return {
    detach: () => {
      registry.events.off("toolInvoked", onInvoked);
      registry.events.off("toolCompleted", onCompleted);
      registry.events.off("toolFailed", onFailed);
      pendingMetaByTool.clear();
      activeMetaByInvocationId.clear();
    },
    recordInvocation,
    getTotalToolCalls: () => totalToolCalls,
  };
}
