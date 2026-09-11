import { z } from "zod";
import {
  PROTO_ENV_NAME,
  reservedScriptEnvName,
  reservedScriptEnvNamesForMessage,
  reservedScriptEnvReason,
  SCRIPT_ENV_NAME_PATTERN,
  type SecretSourceOptions,
} from "@argent/configuration-core";
import { resolveSecretPlaceholders } from "../../../utils/secrets";
import { type FlowScriptSecret } from "./flow-script-executor";

export function describeScriptEnvProblem(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return (
      "must be a map of environment variable names to string values, e.g. " +
      "`env: { API_URL: https://api.example.com }`"
    );
  }
  if (!isPlainMap(raw)) {
    return (
      `is ${describeTaggedMap(raw)} rather than a plain map, so argent reads no entries from ` +
      "it — every name would be dropped and the script would run without them, silently. A " +
      "YAML tag is what builds one; remove it, e.g. " +
      "`env: { API_URL: https://api.example.com }`"
    );
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (name === PROTO_ENV_NAME) return protoEnvNameProblem();
    const reserved = reservedScriptEnvName(name);
    if (reserved) {
      return (
        `holds ${reserved}, which ${reservedScriptEnvReason(reserved)} and cannot be set for a ` +
        `script (reserved names: ${reservedScriptEnvNamesForMessage()})`
      );
    }
    if (!SCRIPT_ENV_NAME_PATTERN.test(name)) {
      return (
        `holds ${JSON.stringify(name)}, which is not an environment variable name — a name ` +
        `starts with a letter or "_" and continues with letters, digits or "_"`
      );
    }
    if (typeof value !== "string") {
      return (
        `holds ${describeValueType(value)} for ${name} — an environment carries strings only, ` +
        `so quote the value`
      );
    }
    const unusable = describeUnusableEnvValue(value);
    if (unusable) return `${unusable} in the value of ${name}`;
  }
  if (process.platform === "win32") {
    const byFold = new Map<string, string>();
    for (const name of Object.keys(raw as Record<string, unknown>)) {
      const folded = name.toLowerCase();
      const first = byFold.get(folded);
      if (first !== undefined) {
        return (
          `holds ${first} and ${name}, which Windows reads as one variable — so one of the two ` +
          `values would be dropped and the script would run with whichever was written last, ` +
          `silently. Give them one spelling, or names of their own`
        );
      }
      byFold.set(folded, name);
    }
  }
  return null;
}

function protoEnvNameProblem(): string {
  return (
    `holds ${PROTO_ENV_NAME}, which argent cannot carry: the operating system takes the ` +
    `name, but every merge on the way to the child copies the map through a plain object, ` +
    `where ${PROTO_ENV_NAME} is an accessor rather than an entry — the value would be ` +
    `dropped and the script would run without it, silently. Use a name of your own`
  );
}

/**
 * The zod shape of a tool's `env` parameter.
 *
 * `z.record` REBUILDS the map, and a JSON body can carry `__proto__` as an own
 * property — `JSON.parse` puts it there without invoking the accessor — so the
 * rebuild dropped it before any rule of argent ran and the call passed with
 * that entry silently gone. Both descriptions said so, and the CLI refused the
 * same name outright: `argent flow run --env __proto__=v` exits 2 with a
 * paragraph of its own, because it builds the map from `NAME=value` pairs and
 * has a rule for this one. An MCP or HTTP caller sends a JSON body instead,
 * which is the only channel the name arrives on as an own property — and that
 * caller reached this schema and got a 200 without a word.
 *
 * Refused where it is still visible, which is before the record is built. The
 * JSON Schema this parameter publishes is unchanged — `whose` names the map,
 * as every other `env` refusal does.
 */
export function scriptEnvParameter(whose: string) {
  return z.preprocess(
    (raw, ctx) => {
      if (
        raw !== null &&
        typeof raw === "object" &&
        Object.getOwnPropertyNames(raw).includes(PROTO_ENV_NAME)
      ) {
        ctx.addIssue({ code: "custom", message: `${whose} \`env\` ${protoEnvNameProblem()}` });
        return z.NEVER;
      }
      return raw;
    },
    z.record(z.string(), z.string())
  );
}

function describeUnusableEnvValue(value: string): string | null {
  if (value.includes("\0")) return "holds a NUL character";
  if (LONE_SURROGATE.test(value)) return "holds an unpaired surrogate";
  return null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainMap(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function describeTaggedMap(value: object): string {
  if (value instanceof Map) return "a Map (`!!omap`)";
  if (value instanceof Set) return "a Set (`!!set`)";
  if (value instanceof Date) return "a Date (`!!timestamp`)";
  return "a tagged value";
}

function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "a map" : `a ${typeof value}`;
}

export function envNameKey(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export function mergeScriptEnv(
  ...maps: Array<Readonly<Record<string, string>> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  const caseInsensitive = process.platform === "win32";
  for (const map of maps) {
    if (!map) continue;
    for (const [name, value] of Object.entries(map)) {
      if (caseInsensitive) {
        for (const seen of Object.keys(merged)) {
          if (seen !== name && seen.toLowerCase() === name.toLowerCase()) delete merged[seen];
        }
      }
      merged[name] = value;
    }
  }
  return merged;
}

export function resolveScriptEnvSecrets(
  env: Readonly<Record<string, string>>,
  options: SecretSourceOptions
): { env: Record<string, string>; secrets: FlowScriptSecret[] } {
  const resolved: Record<string, string> = {};
  const secrets: FlowScriptSecret[] = [];
  for (const [name, value] of Object.entries(env)) {
    let substituted;
    try {
      substituted = resolveSecretPlaceholders(value, options);
    } catch (err) {
      throw new Error(
        `env value ${name}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? { cause: err } : undefined
      );
    }
    // Asked again of what the placeholder RESOLVED to. The rule above ran on
    // the authored value, which is `{{secret:NAME}}` — nothing of the secret's
    // own shape. A NUL inside a resolved credential reaches Node, which refuses
    // the fork and quotes the value back ESCAPED
    // (`Received 'sec\x00ret-9d3f'`), so the scrub — which searches for the raw
    // bytes — finds nothing and the credential is reported in the clear through
    // the very message the redaction exists for. The value is not quoted here.
    const unusable = describeUnusableEnvValue(substituted.text);
    if (unusable) {
      throw new Error(
        `env value ${name}: the value its \`{{secret:}}\` placeholder resolved to ${unusable}, ` +
          `which an environment cannot carry`
      );
    }
    resolved[name] = substituted.text;
    for (const secret of substituted.secrets) {
      if (!secrets.some((seen) => seen.name === secret.name)) secrets.push(secret);
    }
  }
  return { env: resolved, secrets };
}
