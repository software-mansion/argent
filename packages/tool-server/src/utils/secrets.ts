import { FAILURE_CODES } from "@argent/registry";
import { InvalidToolInputError } from "./capability";

/**
 * Server-side secret placeholders for text-entry tools.
 *
 * An agent-composed tool call cannot carry a plaintext credential without the
 * credential entering the model's context, the MCP call log, the event log,
 * and any recorded flow YAML. `{{secret:NAME}}` lets the agent reference a
 * secret by name instead: the placeholder travels through every logging
 * boundary verbatim and is substituted with the value of the
 * `ARGENT_SECRET_<NAME>` environment variable only here, inside the typing
 * tool's `execute` — the last hop before the keystrokes leave for the device.
 *
 * The mandatory `ARGENT_SECRET_` prefix is an allowlist by construction: only
 * variables the user deliberately exposed under that prefix are resolvable, so
 * a prompt-injected agent cannot exfiltrate arbitrary host env vars (e.g.
 * `GITHUB_TOKEN`) through the mechanism.
 */

export const SECRET_ENV_PREFIX = "ARGENT_SECRET_";

/**
 * Cheap containment probe — shared with the MCP layer's auto-screenshot skip,
 * which must not render a just-typed secret back into model context as pixels.
 */
export const SECRET_PLACEHOLDER_MARKER = "{{secret:";

const PLACEHOLDER_RE = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Names (never values) of all secrets currently exposed via the env prefix. */
export function availableSecretNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith(SECRET_ENV_PREFIX) && env[k] !== undefined)
    .map((k) => k.slice(SECRET_ENV_PREFIX.length))
    .sort();
}

export interface ResolvedSecretText {
  /** The input with every placeholder replaced by its secret value. */
  text: string;
  /** The placeholders that were substituted; empty when the input had none. */
  secrets: Array<{ name: string; value: string }>;
}

/**
 * A placeholder name that (redundantly) repeats the env prefix in any casing —
 * `{{secret:ARGENT_SECRET_APP_PASSWORD}}` instead of the canonical
 * `{{secret:APP_PASSWORD}}`. Agents naturally paste the full variable name, so
 * this spelling is accepted as a fallback: the exact name is tried first, and
 * only when that env var doesn't exist is the prefix stripped and retried.
 * Exact-first keeps a literal `ARGENT_SECRET_ARGENT_SECRET_X` var reachable.
 */
const REDUNDANT_PREFIX_RE = /^argent_secret_/i;

/**
 * Replace every `{{secret:NAME}}` in `text` with the value of
 * `ARGENT_SECRET_NAME`. Unknown names reject with a message that lists the
 * *names* of available secrets — never a value — so an agent can self-correct
 * without anything sensitive entering its context.
 */
export function resolveSecretPlaceholders(
  text: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedSecretText {
  const secrets: Array<{ name: string; value: string }> = [];
  const resolved = text.replace(PLACEHOLDER_RE, (placeholder, rawName: string) => {
    let name = rawName;
    let value = env[SECRET_ENV_PREFIX + name];
    if (value === undefined && REDUNDANT_PREFIX_RE.test(name)) {
      name = name.replace(REDUNDANT_PREFIX_RE, "");
      value = env[SECRET_ENV_PREFIX + name];
    }
    if (value === undefined) {
      const names = availableSecretNames(env);
      throw new InvalidToolInputError(
        `Unknown secret "${rawName}" — no ${SECRET_ENV_PREFIX}${name} environment variable is set ` +
          `on the machine running the tool-server. Available secrets: ${
            names.length ? names.join(", ") : "(none)"
          }. To make it available, ask the user to export ${SECRET_ENV_PREFIX}${name} in the ` +
          `tool-server's environment — never ask the user for the secret value itself.`,
        {
          error_code: FAILURE_CODES.SECRET_PLACEHOLDER_UNKNOWN,
          failure_stage: "secret_placeholder_resolution",
          error_kind: "validation",
        }
      );
    }
    if (!secrets.some((s) => s.name === name)) secrets.push({ name, value });
    return value;
  });
  return { text: resolved, secrets };
}

/**
 * Scrub resolved secret values from an error before it propagates — a backend
 * failure can echo its input (e.g. Android typing surfaces the device-side
 * `input text` command line). Mutates message/stack in place so the error's
 * class, and with it the HTTP status and telemetry mapping, is preserved.
 * Zero-length values are skipped: replacing an empty string would corrupt the
 * message rather than redact anything.
 */
export function redactSecretsFromError(
  err: unknown,
  secrets: Array<{ name: string; value: string }>
): unknown {
  const scrub = (s: string) =>
    secrets.reduce(
      (acc, { name, value }) =>
        value ? acc.split(value).join(`${SECRET_PLACEHOLDER_MARKER}${name}}}`) : acc,
      s
    );
  if (err instanceof Error) {
    err.message = scrub(err.message);
    if (err.stack) err.stack = scrub(err.stack);
    return err;
  }
  if (typeof err === "string") return scrub(err);
  return err;
}
