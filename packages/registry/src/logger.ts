import type { Registry } from "./registry";

const PREFIX = "[registry]";

/**
 * Walk the .cause chain and build a single string with all unique messages,
 * then append the deepest available stack trace.
 */
function formatError(error: Error): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (!parts.some((p) => p.includes(current instanceof Error ? current.message : ""))) {
      parts.push(current.message);
    }
    current = current.cause;
  }

  const fullMessage = parts.length === 1 ? parts[0]! : parts.join(" — caused by: ");

  // Prefer the deepest stack in the chain (closest to the actual throw site)
  let deepestStack: string | undefined;
  let cursor: unknown = error;
  while (cursor instanceof Error) {
    if (cursor.stack) deepestStack = cursor.stack;
    cursor = cursor.cause;
  }

  if (deepestStack) {
    // Replace the first line of the stack (which repeats the message) with our
    // full cause-chain message so the log line is self-contained.
    const stackBody = deepestStack.includes("\n")
      ? deepestStack.slice(deepestStack.indexOf("\n"))
      : "";
    return `${fullMessage}${stackBody}`;
  }

  return fullMessage;
}

/**
 * Subscribes to all registry lifetime events and logs them to the console.
 * Call this after creating the registry to observe service/tool lifecycle in the server.
 */
export function attachRegistryLogger(registry: Registry): void {
  registry.events.on("serviceStateChange", (serviceId, from, to) => {
    console.log(`${PREFIX} serviceStateChange ${serviceId}: ${from} → ${to}`);
  });

  registry.events.on("serviceError", (serviceId, error) => {
    console.error(`${PREFIX} serviceError ${serviceId}:\n${formatError(error)}`);
  });

  registry.events.on("serviceRegistered", (serviceId) => {
    console.log(`${PREFIX} serviceRegistered ${serviceId}`);
  });

  registry.events.on("toolRegistered", (toolId) => {
    console.log(`${PREFIX} toolRegistered ${toolId}`);
  });

  registry.events.on("toolInvoked", (toolId) => {
    console.log(`${PREFIX} toolInvoked ${toolId}`);
  });

  registry.events.on("toolCompleted", (toolId, durationMs) => {
    console.log(`${PREFIX} toolCompleted ${toolId} (${durationMs.toFixed(2)}ms)`);
  });

  registry.events.on("toolFailed", (toolId, error) => {
    console.error(`${PREFIX} toolFailed ${toolId}:\n${formatError(error)}`);
  });
}
