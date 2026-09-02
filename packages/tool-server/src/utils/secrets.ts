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
 * Zero-length values are skipped: replacing an empty string would corrupt the
 * text rather than redact anything.
 *
 * Whole texts only: what a caller passes is already finished, so there is no
 * half of a value still to arrive and the walk settles every position it
 * passes. A text that was CUT is the other case, and this function cannot cover
 * it — a value split by the cut leaves a prefix that a whole-value match never
 * finds. A failure message is cut, by the child that has no secret list, so
 * `redactTruncated` in `flow-script-executor.ts` drops that prefix afterwards.
 */
export function scrubSecretValues(
  text: string,
  secrets: ReadonlyArray<{ name: string; value: string }>
): string {
  const ordered = orderedSecrets(secrets);
  if (ordered.length === 0) return text;
  const names = new Set(ordered.map((secret) => secret.name));
  const longestName = Math.max(...ordered.map((secret) => secret.name.length));
  let out = "";
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    // A marker one pass wrote is not text the next may look inside: a value
    // that occurs in some *name* would otherwise be replaced there, nesting one
    // marker inside another and leaving neither the shape a reader parses.
    //
    // Only while the span really is a marker, though. A value that starts
    // inside it and reaches past its end belongs to text that merely looks like
    // one — a script echoing an unresolved `{{secret:NAME}}` — and jumping the
    // span would leave that value in plaintext. A marker left nested is the
    // lesser fault.
    const marker = markerLengthAt(text, at, names, longestName);
    if (marker > 0 && !valueLeavesMarker(text, at, at + marker, ordered)) {
      at += marker;
      continue;
    }
    // Longest value first: one value can contain another — a host inside a URL
    // that is itself a secret — and taking the shorter one would leave the rest
    // of the longer one in the text.
    const hit = ordered.find((secret) => text.startsWith(secret.value, at));
    if (hit) {
      out += `${text.slice(copied, at)}${SECRET_PLACEHOLDER_MARKER}${hit.name}}}`;
      at += hit.value.length;
      copied = at;
      continue;
    }
    at += 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Whether a value starts inside `[from, end)` and runs to the end of the span
 * or past it. A value that ends exactly at `end` counts: it holds the closing
 * characters a reader parses the marker by, and the boundary is set on the
 * scrubbing side on purpose — the cost of counting one is a marker nested in
 * another, the cost of missing one is a value shipped in plaintext.
 *
 * The span is bounded by the longest name there is, so this walk is too.
 */
function valueLeavesMarker(
  text: string,
  from: number,
  end: number,
  ordered: ReadonlyArray<{ value: string }>
): boolean {
  for (let at = from; at < end; at++) {
    for (const { value } of ordered) {
      if (at + value.length >= end && text.startsWith(value, at)) return true;
    }
  }
  return false;
}

function orderedSecrets(
  secrets: ReadonlyArray<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  return secrets
    .filter(({ value }) => value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);
}

function markerLengthAt(
  text: string,
  at: number,
  names: ReadonlySet<string>,
  longestName: number
): number {
  if (!text.startsWith(SECRET_PLACEHOLDER_MARKER, at)) return 0;
  const from = at + SECRET_PLACEHOLDER_MARKER.length;
  // Searched inside a window no longer than the longest name there is, because
  // no wider match could be one: text that opens a marker and never closes it —
  // which a script can write on every line — would otherwise be read to the end
  // of the chunk once per occurrence.
  const window = text.slice(from, from + longestName + 2);
  const end = window.indexOf("}}");
  // Only a name this call would itself write: a `{{secret:X}}` the script
  // printed for an X that is no secret here stays ordinary text, so a value
  // inside it is still replaced.
  return end >= 0 && names.has(window.slice(0, end))
    ? SECRET_PLACEHOLDER_MARKER.length + end + 2
    : 0;
}

/**
 * Scrub resolved secret values from an error before it propagates — a backend
 * failure can echo its input (Android typing surfaces the device-side
 * `input text` command line). Mutates message/stack in place to preserve the
 * error's class, and with it the HTTP status and telemetry mapping.
 */
export function redactSecretsFromError(
  err: unknown,
  secrets: ReadonlyArray<{ name: string; value: string }>
): unknown {
  const scrub = (s: string) => scrubSecretValues(s, secrets);
  if (err instanceof Error) {
    err.message = scrub(err.message);
    if (err.stack) err.stack = scrub(err.stack);
    return err;
  }
  if (typeof err === "string") return scrub(err);
  return err;
}
