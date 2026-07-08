import bunyan from "bunyan";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  FAILURE_CODES,
  getFailureSignalOrFallback,
  type FailureSignal,
  type Registry,
  type ServiceState,
} from "@argent/registry";

export type EventLogValue =
  | string
  | number
  | boolean
  | null
  | EventLogValue[]
  | { [key: string]: EventLogValue | undefined };

export type EventLogRecord = { type: string; msg: string } & Record<
  string,
  EventLogValue | undefined
>;

type EventLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface ToolServerEventLog {
  filePath: string;
  debug: (record: EventLogRecord) => void;
  info: (record: EventLogRecord) => void;
  warn: (record: EventLogRecord) => void;
  error: (record: EventLogRecord) => void;
  fatal: (record: EventLogRecord) => void;
  dispose: () => Promise<void>;
}

export interface CreateToolServerEventLogOptions {
  filePath: string;
}

export function createToolServerEventLog({
  filePath,
}: CreateToolServerEventLogOptions): ToolServerEventLog {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, "");
  const fileStream = createWriteStream(filePath, { flags: "a" });
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let streamError: Error | null = null;

  fileStream.on("error", (error) => {
    disposed = true;
    streamError = new Error(`Event log stream failed for ${filePath}: ${error.message}`, {
      cause: error,
    });
    process.stderr.write(`[tool-server] ${streamError.message}\n`);
  });

  const logger = bunyan.createLogger({
    name: "argent-tool-server",
    streams: [
      {
        level: "info",
        type: "raw",
        stream: {
          write(record: object): void {
            if (!disposed) fileStream.write(JSON.stringify(record) + "\n");
          },
        },
      },
    ],
  });

  function log(level: EventLogLevel, record: EventLogRecord): void {
    const { msg, ...fields } = record;
    logger[level](fields, msg);
  }

  return {
    filePath,
    debug: (record) => log("debug", record),
    info: (record) => log("info", record),
    warn: (record) => log("warn", record),
    error: (record) => log("error", record),
    fatal: (record) => log("fatal", record),
    dispose: () => {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = new Promise<void>((resolve, reject) => {
        if (streamError) {
          reject(streamError);
          return;
        }
        if (fileStream.closed || fileStream.destroyed) {
          resolve();
          return;
        }
        fileStream.once("error", (error) => {
          reject(
            streamError ??
              new Error(`Event log stream failed for ${filePath}: ${error.message}`, {
                cause: error,
              })
          );
        });
        fileStream.end(resolve);
      });
      return disposePromise;
    },
  };
}

export function attachRegistryEventLogger(registry: Registry, eventLog: ToolServerEventLog): void {
  registry.events.on(
    "serviceStateChange",
    (serviceId: string, from: ServiceState, to: ServiceState) => {
      eventLog.info({
        type: "service.state_change",
        msg: `Service ${serviceId} changed state from ${from} to ${to}.`,
        serviceId,
        from,
        to,
      });
    }
  );

  registry.events.on("serviceError", (serviceId: string, error: Error) => {
    eventLog.error({
      type: "service.error",
      msg: `Service ${serviceId} failed.`,
      serviceId,
      failureSignal: {
        ...getFailureSignalOrFallback(error, {
          error_code: FAILURE_CODES.REGISTRY_SERVICE_INITIALIZATION_FAILED,
          failure_stage: "registry_service_error_event",
          failure_area: "registry",
          error_kind: "unknown",
        }),
      },
    });
  });

  registry.events.on("serviceRegistered", (serviceId: string) => {
    eventLog.info({
      type: "service.registered",
      msg: `Service ${serviceId} was registered.`,
      serviceId,
    });
  });

  registry.events.on("toolRegistered", (toolId: string) => {
    eventLog.info({
      type: "tool.registered",
      msg: `Tool ${toolId} was registered.`,
      toolId,
    });
  });

  registry.events.on("toolInvoked", (toolId: string, toolInvocationId: string) => {
    eventLog.info({
      type: "tool.invoked",
      msg: `Tool ${toolId} was invoked.`,
      toolId,
      toolInvocationId,
    });
  });

  registry.events.on(
    "toolCompleted",
    (toolId: string, toolInvocationId: string, durationMs: number) => {
      eventLog.info({
        type: "tool.completed",
        msg: `Tool ${toolId} completed in ${durationMs.toFixed(2)} ms.`,
        toolId,
        toolInvocationId,
        durationMs,
      });
    }
  );

  registry.events.on(
    "toolFailed",
    (toolId: string, toolInvocationId: string, error: Error, durationMs?: number) => {
      eventLog.error({
        type: "tool.failed",
        msg: `Tool ${toolId} failed.`,
        toolId,
        toolInvocationId,
        failureSignal: {
          ...getFailureSignalOrFallback(error, {
            error_code: FAILURE_CODES.REGISTRY_TOOL_FAILURE_UNCLASSIFIED,
            failure_stage: "registry_tool_failed_event",
            failure_area: "registry",
            error_kind: "unknown",
          }),
        },
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  );
}
