import { FAILURE_CODES } from "@argent/registry";
import { InvalidToolInputError } from "./capability";
import {
  describeSecretSources,
  lookupSecret,
  secretNames,
  secretPlacementAdvice,
  secretSources,
  SECRET_ENV_PREFIX,
  type SecretSource,
  type SecretSourceOptions,
} from "@argent/configuration-core";

/**
 * Server-side secret placeholders for text-entry tools.
 *
 * An agent-composed tool call cannot carry a plaintext credential without the
 * credential entering the model's context, the MCP call log, the event log,
 * and any recorded flow YAML. `{{secret:NAME}}` lets the agent reference a
 * secret by name instead: the placeholder travels through every logging
 * boundary verbatim and is substituted with the secret's value only here,
 * inside the typing tool's `execute` — the last hop before the keystrokes leave
 * for the device.
 *
 * Where a name's value comes from — the `ARGENT_SECRET_<NAME>` environment
 * variable, or a dotenv file in the project or under the user's `~/.argent` —
 * is owned by {@link secretSources}, which documents why each source exposes
 * what it does. What matters here is the property they share: only values the
 * user deliberately exposed to argent are resolvable, so a prompt-injected
 * agent cannot exfiltrate arbitrary host secrets through the mechanism.
 */

export { SECRET_ENV_PREFIX };
export type { SecretSourceOptions };

/**
 * Cheap containment probe — shared with the MCP layer's auto-screenshot skip,
 * which must not render a just-typed secret back into model context as pixels.
 */
export const SECRET_PLACEHOLDER_MARKER = "{{secret:";

const PLACEHOLDER_RE = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Names (never values) of all secrets currently exposed to argent. */
export function availableSecretNames(options: SecretSourceOptions = {}): string[] {
  return secretNames(secretSources(options));
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
 * only when no source defines it is the prefix stripped and the lookup retried.
 * Exact-first keeps a literal `ARGENT_SECRET_ARGENT_SECRET_X` var reachable.
 */
const REDUNDANT_PREFIX_RE = /^argent_secret_/i;

/**
 * Replace every `{{secret:NAME}}` in `text` with its value, resolved through
 * the source chain. Unknown names reject with a message that lists the *names*
 * of available secrets and the sources consulted — never a value — so an agent
 * can self-correct without anything sensitive entering its context.
 *
 * The chain is built once per call and only when the text actually references a
 * secret: a typing call with no placeholder — the overwhelming majority — never
 * touches the filesystem, and one that types several placeholders reads each
 * file once and resolves them all against the same snapshot.
 */
export function resolveSecretPlaceholders(
  text: string,
  options: SecretSourceOptions = {}
): ResolvedSecretText {
  const secrets: Array<{ name: string; value: string }> = [];
  let sources: SecretSource[] | undefined;
  const resolved = text.replace(PLACEHOLDER_RE, (_placeholder, rawName: string) => {
    sources ??= secretSources(options);
    let name = rawName;
    let value = lookupSecret(name, sources);
    if (value === undefined && REDUNDANT_PREFIX_RE.test(name)) {
      name = name.replace(REDUNDANT_PREFIX_RE, "");
      value = lookupSecret(name, sources);
    }
    if (value === undefined) {
      const names = secretNames(sources);
      throw new InvalidToolInputError(
        `Unknown secret "${rawName}" — no source on the machine running the tool-server defines ` +
          `${name}. Available secrets: ${names.length ? names.join(", ") : "(none)"}.\n` +
          `Sources consulted, first match wins:\n${describeSecretSources(sources)}\n` +
          secretPlacementAdvice(name, options),
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
