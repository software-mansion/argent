import type { Registry } from "./registry";

const PREFIX = "[registry]";

/** Flattens the .cause chain into one message plus the deepest stack. */
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

  // The deepest stack is the one closest to the actual throw site
  let deepestStack: string | undefined;
  let cursor: unknown = error;
  while (cursor instanceof Error) {
    if (cursor.stack) deepestStack = cursor.stack;
    cursor = cursor.cause;
  }

  if (deepestStack) {
    // The stack's first line repeats only the innermost message; swap in the whole chain
    // so the log line is self-contained.
    const stackBody = deepestStack.includes("\n")
      ? deepestStack.slice(deepestStack.indexOf("\n"))
      : "";
    return `${fullMessage}${stackBody}`;
  }

  return fullMessage;
}

/** Logs every registry event to the console. */
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

  registry.events.on("toolInvoked", (toolId, toolInvocationId) => {
    console.log(`${PREFIX} toolInvoked ${toolId} (${toolInvocationId})`);
  });

  registry.events.on("toolCompleted", (toolId, toolInvocationId, durationMs) => {
    console.log(
      `${PREFIX} toolCompleted ${toolId} (${toolInvocationId}, ${durationMs.toFixed(2)}ms)`
    );
  });

  registry.events.on("toolFailed", (toolId, toolInvocationId, error) => {
    console.error(`${PREFIX} toolFailed ${toolId} (${toolInvocationId}):\n${formatError(error)}`);
  });
}
