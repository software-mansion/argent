import { FAILURE_CODES } from "@argent/registry";
import { InvalidToolInputError } from "./capability";
import {
  describeSecretSources,
  lookupSecret,
  secretNames,
  secretPlacementAdvice,
  secretSources,
  type SecretSource,
  type SecretSourceOptions,
} from "@argent/configuration-core";

/**
 * Server-side secret placeholders for text-entry tools.
 *
 * A plaintext credential in an agent-composed tool call enters the model's
 * context, the MCP call log, the event log and any recorded flow YAML.
 * `{{secret:NAME}}` crosses those boundaries verbatim and is substituted only
 * in the tool's `execute`, the last hop before the device.
 *
 * Which names resolve is owned by {@link secretSources}: only values the user
 * deliberately exposed to argent, so a prompt-injected agent cannot exfiltrate
 * arbitrary host secrets through the mechanism.
 */

export type { SecretSourceOptions };

/** Copied in packages/argent-mcp/src/auto-capture.ts, which cannot depend on this package. */
export const SECRET_PLACEHOLDER_MARKER = "{{secret:";

const PLACEHOLDER_RE = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Names (never values) of all secrets currently exposed to argent. */
export function availableSecretNames(options: SecretSourceOptions = {}): string[] {
  return secretNames(secretSources(options));
}

interface ResolvedSecretText {
  /** The input with every placeholder replaced by its secret value. */
  text: string;
  /** The substituted secrets; empty when the input had none. */
  secrets: Array<{ name: string; value: string }>;
}

/**
 * A placeholder name redundantly repeating the env prefix in any casing —
 * `{{secret:ARGENT_SECRET_APP_PASSWORD}}` for `{{secret:APP_PASSWORD}}` —
 * accepted as a fallback because agents paste the full variable name. The
 * exact name is tried first, which keeps a literal
 * `ARGENT_SECRET_ARGENT_SECRET_X` var reachable.
 */
const REDUNDANT_PREFIX_RE = /^argent_secret_/i;

/**
 * Replace every `{{secret:NAME}}` in `text` with its value. An unknown name
 * rejects with the *names* of available secrets and the sources consulted —
 * never a value — so an agent can self-correct.
 *
 * The source chain is built lazily and once per call: text with no placeholder
 * never touches the filesystem, and several placeholders resolve against one
 * snapshot.
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
 * failure can echo its input (Android typing surfaces the device-side
 * `input text` command line). Mutates message/stack in place to preserve the
 * error's class, and with it the HTTP status and telemetry mapping.
 * Zero-length values are skipped: splitting on "" would corrupt the message
 * rather than redact anything.
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
