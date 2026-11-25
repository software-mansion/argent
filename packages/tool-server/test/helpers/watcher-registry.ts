import {
  ServiceState,
  TypedEventEmitter,
  type Registry,
  type RegistryEvents,
} from "@argent/registry";

/** A registry stub the simulator watcher can subscribe to. */
export function watcherRegistry(services: Partial<Registry> = {}): Registry {
  return { ...services, events: new TypedEventEmitter<RegistryEvents>() } as unknown as Registry;
}

/** What a tool resolving each simulator's native-devtools service tells the watcher. */
export function targetSimulators(registry: Registry, ...udids: string[]): void {
  for (const udid of udids) {
    registry.events.emit(
      "serviceStateChange",
      `NativeDevtools:${udid}`,
      ServiceState.STARTING,
      ServiceState.RUNNING
    );
  }
}
