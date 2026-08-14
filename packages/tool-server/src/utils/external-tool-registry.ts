import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";

import Ajv, { type ValidateFunction } from "ajv";
import { createJiti } from "jiti";
import {
  FAILURE_CODES,
  FailureError,
  ToolExecutionError,
  type ExternalToolDefinitionV1,
  type ExternalToolRegistryModuleV1,
  type InvokeToolOptions,
  type Registry,
  type ToolDefinition,
  type ToolDependency,
  type ToolInvoker,
} from "@argent/registry";

import { assertSupported } from "./capability";
import { ensureDeps } from "./check-deps";
import { resolveDevice } from "./device-info";

const TOOL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const TOOL_DEPENDENCIES = new Set<ToolDependency>([
  "xcrun",
  "adb",
  "emulator",
  "sim-remote",
  "vega",
]);

interface ExternalToolRecord {
  definition: ExternalToolDefinitionV1;
  lookupDefinition: ToolDefinition;
  validate: ValidateFunction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function invalidRegistry(message: string, cause?: unknown): FailureError {
  return new FailureError(
    `Invalid external tool registry: ${message}`,
    {
      error_code: FAILURE_CODES.FLOW_EXTERNAL_REGISTRY_INVALID,
      failure_stage: "flow_external_registry_validate",
      failure_area: "tool_server",
      error_kind: "validation",
    },
    cause === undefined ? undefined : { cause: asError(cause) }
  );
}

function loadFailure(registryPath: string, cause: unknown): FailureError {
  const error = asError(cause);
  return new FailureError(
    `Could not load external tool registry ${JSON.stringify(registryPath)}: ${error.message}`,
    {
      error_code: FAILURE_CODES.FLOW_EXTERNAL_REGISTRY_LOAD_FAILED,
      failure_stage: "flow_external_registry_load",
      failure_area: "tool_server",
      error_kind: "validation",
    },
    { cause: error }
  );
}

function validateCapability(value: unknown, toolId: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidRegistry(`tool "${toolId}" capability must be an object`);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "apple")) {
    throw invalidRegistry(`tool "${toolId}" capability only supports the "apple" key in version 1`);
  }
  if (value.apple === undefined) return;
  if (!isRecord(value.apple)) {
    throw invalidRegistry(`tool "${toolId}" capability.apple must be an object`);
  }
  const appleKeys = Object.keys(value.apple);
  if (appleKeys.some((key) => key !== "simulator" && key !== "device")) {
    throw invalidRegistry(
      `tool "${toolId}" capability.apple only supports "simulator" and "device"`
    );
  }
  for (const key of appleKeys) {
    if (typeof value.apple[key] !== "boolean") {
      throw invalidRegistry(`tool "${toolId}" capability.apple.${key} must be a boolean`);
    }
  }
}

function validateRequires(value: unknown, toolId: string): asserts value is ToolDependency[] {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw invalidRegistry(`tool "${toolId}" requires must be an array`);
  }
  const seen = new Set<string>();
  for (const dependency of value) {
    if (typeof dependency !== "string" || !TOOL_DEPENDENCIES.has(dependency as ToolDependency)) {
      throw invalidRegistry(
        `tool "${toolId}" has unsupported dependency ${JSON.stringify(dependency)}`
      );
    }
    if (seen.has(dependency)) {
      throw invalidRegistry(`tool "${toolId}" lists dependency "${dependency}" more than once`);
    }
    seen.add(dependency);
  }
}

function moduleValue(namespace: unknown): unknown {
  if (!isRecord(namespace)) return namespace;
  const defaultExport = namespace.default;
  if (
    isRecord(defaultExport) &&
    (Object.hasOwn(defaultExport, "version") || Object.hasOwn(defaultExport, "tools"))
  ) {
    return defaultExport;
  }
  return namespace;
}

function deviceArg(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  for (const key of ["udid", "device_id", "device"] as const) {
    if (typeof params[key] === "string" && params[key].length > 0) return params[key];
  }
  return undefined;
}

function normalizeJsonResult(value: unknown, toolId: string): unknown {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new FailureError(
      `External tool "${toolId}" returned a result that is not JSON-serializable: ${asError(error).message}`,
      {
        error_code: FAILURE_CODES.FLOW_EXTERNAL_TOOL_RESULT_INVALID,
        failure_stage: "flow_external_tool_serialize_result",
        failure_area: "tool_server",
        error_kind: "validation",
      },
      { cause: asError(error) }
    );
  }
  if (encoded === undefined) {
    throw new FailureError(
      `External tool "${toolId}" returned a result that is not JSON-serializable`,
      {
        error_code: FAILURE_CODES.FLOW_EXTERNAL_TOOL_RESULT_INVALID,
        failure_stage: "flow_external_tool_serialize_result",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  return JSON.parse(encoded) as unknown;
}

/**
 * Invocation-local dispatch: external IDs resolve to their structural module;
 * every other lookup/invocation stays on the long-lived built-in Registry.
 */
class CompositeToolInvoker implements ToolInvoker {
  constructor(
    private readonly builtIns: Registry,
    private readonly externalTools: ReadonlyMap<string, ExternalToolRecord>
  ) {}

  getTool(id: string): ToolDefinition | undefined {
    return this.externalTools.get(id)?.lookupDefinition ?? this.builtIns.getTool(id);
  }

  async invokeTool<TResult = unknown>(
    id: string,
    params?: unknown,
    options?: InvokeToolOptions
  ): Promise<TResult> {
    const record = this.externalTools.get(id);
    if (!record) return this.builtIns.invokeTool<TResult>(id, params, options);

    const toolInvocationId = options?.toolInvocationId ?? randomUUID();
    const startedAt = performance.now();
    this.builtIns.events.emit(
      "toolInvoked",
      id,
      toolInvocationId,
      `External tool ${id} was invoked.`
    );

    try {
      const effectiveParams = params ?? {};
      if (!record.validate(effectiveParams)) {
        const detail = record.validate.errors
          ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
          .join("; ");
        throw new FailureError(
          `Invalid params for external tool "${id}"${detail ? `: ${detail}` : ""}`,
          {
            error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
            failure_stage: "flow_external_tool_validate_input",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }

      const target = deviceArg(effectiveParams);
      if (record.definition.capability && target) {
        assertSupported(id, record.definition.capability, resolveDevice(target));
      }
      if (record.definition.requires?.length) await ensureDeps(record.definition.requires);

      const rawResult = await record.definition.execute(effectiveParams, {
        signal: options?.signal,
        toolInvocationId,
      });
      const result = normalizeJsonResult(rawResult, id) as TResult;
      const duration = performance.now() - startedAt;
      this.builtIns.events.emit(
        "toolCompleted",
        id,
        toolInvocationId,
        duration,
        `External tool ${id} completed in ${duration.toFixed(2)} ms.`
      );
      return result;
    } catch (error) {
      const cause = asError(error);
      const wrapped = new ToolExecutionError(id, cause.message, { cause });
      this.builtIns.events.emit(
        "toolFailed",
        id,
        toolInvocationId,
        wrapped,
        performance.now() - startedAt,
        `External tool ${id} failed.`
      );
      throw wrapped;
    }
  }
}

function validateModule(value: unknown, builtIns: Registry): Map<string, ExternalToolRecord> {
  if (!isRecord(value)) throw invalidRegistry("module must export an object");
  if (value.version !== 1) {
    throw invalidRegistry(`unsupported version ${JSON.stringify(value.version)}; expected 1`);
  }
  if (!Array.isArray(value.tools)) throw invalidRegistry('"tools" must be an array');

  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const externalTools = new Map<string, ExternalToolRecord>();
  for (const [index, rawTool] of value.tools.entries()) {
    if (!isRecord(rawTool)) throw invalidRegistry(`tools[${index}] must be an object`);
    const id = rawTool.id;
    if (typeof id !== "string" || !TOOL_ID_PATTERN.test(id)) {
      throw invalidRegistry(
        `tools[${index}].id must match ${TOOL_ID_PATTERN}; got ${JSON.stringify(id)}`
      );
    }
    if (externalTools.has(id)) throw invalidRegistry(`duplicate external tool id "${id}"`);
    if (builtIns.getTool(id))
      throw invalidRegistry(`external tool id "${id}" collides with a built-in tool`);
    if (typeof rawTool.description !== "string" || rawTool.description.trim() === "") {
      throw invalidRegistry(`tool "${id}" must have a non-empty description`);
    }
    if (!isRecord(rawTool.inputSchema)) {
      throw invalidRegistry(`tool "${id}" inputSchema must be a JSON Schema object`);
    }
    if (rawTool.inputSchema.$async === true) {
      throw invalidRegistry(`tool "${id}" inputSchema must use synchronous JSON Schema validation`);
    }
    if (typeof rawTool.execute !== "function") {
      throw invalidRegistry(`tool "${id}" must have an execute function`);
    }
    validateCapability(rawTool.capability, id);
    validateRequires(rawTool.requires, id);

    let validate: ValidateFunction;
    try {
      if (!ajv.validateSchema(rawTool.inputSchema)) {
        throw new Error(ajv.errorsText(ajv.errors));
      }
      validate = ajv.compile(rawTool.inputSchema);
    } catch (error) {
      throw invalidRegistry(
        `tool "${id}" inputSchema is invalid: ${asError(error).message}`,
        error
      );
    }

    const definition = rawTool as unknown as ExternalToolDefinitionV1;
    const lookupDefinition: ToolDefinition = {
      id,
      description: definition.description,
      inputSchema: definition.inputSchema,
      capability: definition.capability,
      requires: definition.requires,
      services: () => ({}),
      async execute(_services, params, ctx) {
        return definition.execute(params, {
          signal: ctx?.signal,
          toolInvocationId: ctx?.toolInvocationId,
        });
      },
    };
    externalTools.set(id, { definition, lookupDefinition, validate });
  }
  return externalTools;
}

/**
 * Load and validate a trusted local TypeScript registry exactly once for one
 * flow invocation. Both jiti caches are disabled so a later invocation sees
 * edits to the same path; the returned definitions stay stable mid-run.
 */
export async function loadExternalToolRegistry(
  registryPath: string,
  builtIns: Registry
): Promise<ToolInvoker> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(registryPath);
    const stat = await fs.stat(canonicalPath);
    if (!stat.isFile()) throw new Error("path is not a file");
    await fs.access(canonicalPath, fsConstants.R_OK);
  } catch (error) {
    throw loadFailure(registryPath, error);
  }

  let namespace: unknown;
  try {
    const jiti = createJiti(__filename, {
      moduleCache: false,
      fsCache: false,
      interopDefault: false,
    });
    namespace = await jiti.import(canonicalPath);
  } catch (error) {
    throw loadFailure(canonicalPath, error);
  }

  const externalTools = validateModule(moduleValue(namespace), builtIns);
  return new CompositeToolInvoker(builtIns, externalTools);
}

/** Canonical TypeScript-facing shape; the runtime remains structural. */
export type { ExternalToolRegistryModuleV1 };
