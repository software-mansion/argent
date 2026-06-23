import bunyan from "bunyan";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Registry, ServiceState } from "@argent/registry";

export type EventLogValue =
  | string
  | number
  | boolean
  | null
  | EventLogValue[]
  | { [key: string]: EventLogValue | undefined };

export type EventLogRecord = { type: string; msg: string; err?: Error } & Record<
  string,
  EventLogValue | Error | undefined
>;

type EventLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface ToolServerEventLog {
  filePath: string;
  debug: (record: EventLogRecord) => void;
  info: (record: EventLogRecord) => void;
  warn: (record: EventLogRecord) => void;
  error: (record: EventLogRecord) => void;
  fatal: (record: EventLogRecord) => void;
  dispose: () => void;
}

export interface CreateToolServerEventLogOptions {
  filePath: string;
}

function serializeError(error: Error): Record<string, unknown> {
  const serialized = bunyan.stdSerializers.err(error) as Record<string, unknown>;
  if (error.cause instanceof Error) {
    serialized.cause = serializeError(error.cause);
  }
  return serialized;
}

export function createToolServerEventLog({
  filePath,
}: CreateToolServerEventLogOptions): ToolServerEventLog {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, "");

  const logger = bunyan.createLogger({
    name: "argent-tool-server",
    serializers: {
      err: serializeError,
    },
    streams: [
      {
        level: "info",
        type: "raw",
        stream: {
          write(record: object): void {
            appendFileSync(filePath, JSON.stringify(record) + "\n");
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
    dispose: () => {},
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
      err: error,
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
        err: error,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
  );
}
