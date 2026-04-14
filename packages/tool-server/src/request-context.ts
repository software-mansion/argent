import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Absolute filesystem path to the MCP client's workspace root. */
  projectRoot: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireProjectRoot(): string {
  const ctx = storage.getStore();
  if (!ctx?.projectRoot) {
    throw new Error(
      "No project root in request context. Tools that need a project root " +
        "must be invoked through the argent mcp proxy, which stamps " +
        "X-Argent-Project-Root on each tool call. In tests, wrap the call " +
        "in runWithContext({ projectRoot }, ...)."
    );
  }
  return ctx.projectRoot;
}
