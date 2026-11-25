import {
  ServiceState,
  TypedEventEmitter,
  type Registry,
  type RegistryEvents,
} from "@argent/registry";
import { nativeDevtoolsRef } from "../../src/blueprints/native-devtools";

/** A registry stub the simulator watcher can subscribe to. */
export function watcherRegistry(services: Partial<Registry> = {}): Registry {
  return { ...services, events: new TypedEventEmitter<RegistryEvents>() } as unknown as Registry;
}

/** What a tool resolving each simulator's native-devtools service tells the watcher. */
export function targetSimulators(registry: Registry, ...udids: string[]): void {
  for (const udid of udids) {
    registry.events.emit(
      "serviceStateChange",
      nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" }).urn,
      ServiceState.STARTING,
      ServiceState.RUNNING
    );
  }
}

/** What a tool stopping each simulator's native-devtools service tells the watcher. */
export function untargetSimulators(registry: Registry, ...udids: string[]): void {
  for (const udid of udids) {
    registry.events.emit(
      "serviceStateChange",
      nativeDevtoolsRef({ id: udid, platform: "ios", kind: "simulator" }).urn,
      ServiceState.TERMINATING,
      ServiceState.IDLE
    );
  }
}
