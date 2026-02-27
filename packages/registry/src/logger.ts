import type { Registry } from './registry';

const PREFIX = '[registry]';

/**
 * Subscribes to all registry lifetime events and logs them to the console.
 * Call this after creating the registry to observe service/tool lifecycle in the server.
 */
export function attachRegistryLogger(registry: Registry): void {
  registry.events.on('serviceStateChange', (serviceId, from, to) => {
    console.log(
      `${PREFIX} serviceStateChange ${serviceId}: ${from} → ${to}`
    );
  });

  registry.events.on('serviceError', (serviceId, error) => {
    console.error(
      `${PREFIX} serviceError ${serviceId}:`,
      error.message,
      error.cause ? `(cause: ${error.cause})` : ''
    );
  });

  registry.events.on('serviceRegistered', (serviceId) => {
    console.log(`${PREFIX} serviceRegistered ${serviceId}`);
  });

  registry.events.on('toolRegistered', (toolId) => {
    console.log(`${PREFIX} toolRegistered ${toolId}`);
  });

  registry.events.on('toolInvoked', (toolId) => {
    console.log(`${PREFIX} toolInvoked ${toolId}`);
  });

  registry.events.on('toolCompleted', (toolId, durationMs) => {
    console.log(
      `${PREFIX} toolCompleted ${toolId} (${durationMs.toFixed(2)}ms)`
    );
  });

  registry.events.on('toolFailed', (toolId, error) => {
    console.error(
      `${PREFIX} toolFailed ${toolId}:`,
      error.message,
      error.cause ? `(cause: ${error.cause})` : ''
    );
  });
}
