import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  GATED_OPERATIONS,
  type GatedOperation,
  type ToolDefinition,
} from "@argent/registry";
import {
  DEVICE_BIND_KEYS,
  DEVICE_BIND_LIST_KEYS,
  DEVICE_LAUNCH_TARGET_KEYS,
} from "./utils/device-param-keys";

/**
 * Operator rules one tool-server enforces on every tool invocation it admits,
 * including the nested ones flows and run-sequence make. Read once at startup
 * and never reloaded, so a running server has exactly one policy.
 */
export const SERVER_POLICY_ENV = "ARGENT_SERVER_POLICY";

const toolNames = z.array(z.string().min(1));

const policyFileSchema = z
  .object({
    version: z.literal(1),
    devices: z
      .object({ allow: z.array(z.string().trim().min(1)).min(1) })
      .strict()
      .optional(),
    tools: z
      .union([z.object({ allow: toolNames }).strict(), z.object({ deny: toolNames }).strict()])
      .optional(),
    operations: z
      .object({ deny: z.array(z.enum(GATED_OPERATIONS)) })
      .strict()
      .optional(),
  })
  .strict();

interface ServerPolicy {
  readonly sourcePath: string;
  /** Device ids the server may act on. Absent when every device is allowed. */
  readonly deviceIds?: ReadonlySet<string>;
  readonly tools?: { readonly mode: "allow" | "deny"; readonly ids: ReadonlySet<string> };
  readonly deniedOperations: ReadonlySet<GatedOperation>;
}

export class ServerPolicyConfigError extends Error {
  constructor(sourcePath: string, problem: string) {
    super(`Invalid server policy ${sourcePath}: ${problem}`);
    this.name = "ServerPolicyConfigError";
  }
}

export function loadServerPolicy(env: NodeJS.ProcessEnv = process.env): ServerPolicy | undefined {
  const configured = env[SERVER_POLICY_ENV]?.trim();
  if (!configured) return undefined;
  const sourcePath = path.resolve(configured);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (err) {
    throw new ServerPolicyConfigError(
      sourcePath,
      `cannot read policy JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return parseServerPolicy(raw, sourcePath);
}

export function parseServerPolicy(raw: unknown, sourcePath: string): ServerPolicy {
  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `"${issue.path.join(".")}"` : "policy";
    throw new ServerPolicyConfigError(sourcePath, `${where}: ${issue?.message ?? "invalid"}`);
  }
  const { devices, tools, operations } = parsed.data;
  const deviceIds = devices ? new Set(devices.allow) : undefined;
  const toolRules = tools
    ? "allow" in tools
      ? { mode: "allow" as const, ids: new Set(tools.allow) }
      : { mode: "deny" as const, ids: new Set(tools.deny) }
    : undefined;
  const deniedOperations = new Set(operations?.deny ?? []);
  return {
    sourcePath,
    deviceIds,
    tools: toolRules,
    deniedOperations,
  };
}

/** Fails startup when the policy names a tool this server does not register. */
export function assertPolicyToolsRegistered(
  policy: ServerPolicy,
  isRegistered: (id: string) => boolean
): void {
  for (const id of policy.tools?.ids ?? []) {
    if (!isRegistered(id)) {
      throw new ServerPolicyConfigError(
        policy.sourcePath,
        `"tools" names "${id}", which this tool-server does not register`
      );
    }
  }
}

let activePolicy: ServerPolicy | undefined;

/** Installed once by the tool-server at startup; tests install and clear it. */
export function installServerPolicy(policy: ServerPolicy | undefined): void {
  activePolicy = policy;
}

/** Refuses a tool invocation the active policy denies, before its services resolve. */
export function admitToolInvocation(definition: ToolDefinition, params: unknown): void {
  const policy = activePolicy;
  if (!policy) return;
  const rules = policy.tools;
  if (rules) {
    const listed = rules.ids.has(definition.id);
    if (rules.mode === "allow" ? !listed : listed) {
      throw policyDenied("tool", `the "${definition.id}" tool is denied`);
    }
  }
  for (const operation of definition.gatedOperations?.(params as never) ?? []) {
    assertOperationAllowed(operation);
  }
  if (!policy.deviceIds || !params || typeof params !== "object") return;
  const args = params as Record<string, unknown>;
  for (const key of DEVICE_LAUNCH_TARGET_KEYS) {
    if (args[key] !== undefined) {
      throw policyDenied(
        "device",
        `"${key}" launches a device outside the allowed device ids; boot an allowed device by its id`
      );
    }
  }
  const named = [
    ...DEVICE_BIND_KEYS.map((key) => args[key]),
    ...DEVICE_BIND_LIST_KEYS.flatMap((key) => (Array.isArray(args[key]) ? args[key] : [])),
  ];
  for (const id of named) if (typeof id === "string") assertDeviceAllowed(id);
}

export function hasDeviceAllowlist(): boolean {
  return activePolicy?.deviceIds !== undefined;
}

export function isDeviceAllowed(id: string): boolean {
  return !activePolicy?.deviceIds || activePolicy.deviceIds.has(id);
}

function assertDeviceAllowed(id: string): void {
  if (!isDeviceAllowed(id)) throw policyDenied("device", `device "${id}" is not allowed`);
}

export function isOperationDenied(operation: GatedOperation): boolean {
  return activePolicy?.deniedOperations.has(operation) ?? false;
}

export function assertOperationAllowed(operation: GatedOperation): void {
  if (isOperationDenied(operation)) {
    throw policyDenied("operation", `the "${operation}" operation is denied`);
  }
}

function policyDenied(rule: "tool" | "device" | "operation", what: string): FailureError {
  return new FailureError(
    `Denied by this tool-server's operator policy: ${what}. Retrying will not help; use an ` +
      `allowed tool and device, or ask the operator to change ${SERVER_POLICY_ENV}.`,
    {
      error_code: FAILURE_CODES.SERVER_POLICY_DENIED,
      error_kind: "unsupported",
      failure_area: "tool_server",
      failure_stage: `server_policy_${rule}`,
    }
  );
}
