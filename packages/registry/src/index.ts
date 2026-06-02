export { TypedEventEmitter } from "./event-emitter";
export { ServiceState } from "./types";
export type {
  ServiceEvents,
  ServiceInstance,
  ServiceBlueprint,
  ServiceNode,
  ToolDefinition,
  ToolRecord,
  RegistryEvents,
  URN,
  ServiceRef,
  InvokeToolOptions,
  Platform,
  DeviceKind,
  DeviceInfo,
  ToolCapability,
  ToolDependency,
} from "./types";
export { parseURN } from "./urn";
export {
  ServiceNotFoundError,
  ServiceInitializationError,
  ToolNotFoundError,
  ToolExecutionError,
  FailureError,
  FAILURE_AREAS,
  FAILURE_COMMANDS,
  FAILURE_KINDS,
  FAILURE_SIGNAL_NAMES,
  FAILURE_SPAWN_CODES,
  NETWORK_FAILURES,
  failureSignal,
  subprocessFailureMetadata,
  withFailureSignal,
  wrapFailure,
  getFailureSignal,
  getFailureSignalOrFallback,
} from "./errors";
export type {
  FailureArea,
  FailureCommand,
  FailureKind,
  FailureSignal,
  FailureSignalName,
  FailureSpawnCode,
  NetworkFailure,
} from "./errors";
export { FAILURE_CODES } from "./failure-codes";
export type { FailureCode } from "./failure-codes";
export { Registry } from "./registry";
export { attachRegistryLogger } from "./logger";
export { zodObjectToJsonSchema } from "./zod-to-json-schema";
