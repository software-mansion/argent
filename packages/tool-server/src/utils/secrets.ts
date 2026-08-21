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
 * The shortest piece of a secret worth searching an error message for.
 *
 * A backend that types a value one word at a time yields pieces as short as a
 * single character, and blanking every `a` in a diagnostic destroys the message
 * the agent has to act on. Three characters of a credential is not a disclosure
 * worth that.
 */
const MIN_REDACTED_PIECE = 4;

/** `%`-delimited segments, each keeping its trailing `%`. */
function percentSegments(text: string): string[] {
  return text.match(/[^%]*%|[^%]+/g) ?? [];
}

/**
 * Every spelling of a secret that can reach an error message.
 *
 * Two things stand between the resolved value and the message, and both fail
 * silently — a secret with neither an apostrophe nor a split redacts correctly,
 * so the gap stays invisible until the one that has them leaks:
 *
 * - The backends that echo their input echo a SHELL LINE (`adb shell input text
 *   'x'`, `hdc shell uitest uiInput text 'x'`), and `shellQuote` rewrites each
 *   `'` as `'\''`, so an apostrophe breaks the value into non-contiguous text.
 * - A backend need not send the value in one piece. `injectAndroidText` starts a
 *   new `adb shell input text` at every `%` so the device never sees a format
 *   specifier, and the Android TV remote types a word per space keyevent — so
 *   the call that fails quotes back a PIECE, not the whole.
 *
 * The pieces are the ones those splits really produce, not every substring:
 * searching for arbitrary runs blanks the ordinary words of a diagnostic
 * whenever a secret happens to contain one.
 */
function secretSpellings(value: string): string[] {
  const pieces = new Set<string>([value, ...percentSegments(value)]);
  for (const word of value.split(" ")) {
    pieces.add(word);
    for (const segment of percentSegments(word)) pieces.add(segment);
  }
  const spellings = new Set<string>();
  for (const piece of pieces) {
    if (piece !== value && piece.length < MIN_REDACTED_PIECE) continue;
    spellings.add(piece);
    spellings.add(piece.replaceAll("'", `'\\''`));
  }
  return [...spellings];
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
  const marked = new Map<string, string>();
  for (const { name, value } of secrets) {
    if (!value) continue;
    for (const spelling of secretSpellings(value)) {
      if (!marked.has(spelling)) marked.set(spelling, `${SECRET_PLACEHOLDER_MARKER}${name}}}`);
    }
  }
  if (marked.size === 0) return err;
  // Bucketed by first character, longest first inside each bucket. Longest wins
  // at a position, or the whole value loses to a piece of itself and the rest of
  // it is left standing beside the marker.
  //
  // Matched by hand rather than by an alternation `RegExp`, which a secret can
  // be too long to compile into: from 32768 characters V8 refuses the pattern
  // with a `SyntaxError` QUOTING IT, so the one call that exists to keep the
  // credential out of the message would hand over the whole of it. A PEM bundle
  // or a base64 keystore reaches that size, and `paste` invites exactly those.
  // The throw comes at the first match attempt, not from the constructor —
  // compilation is lazy — so guarding `new RegExp` would not have caught it.
  const byFirstChar = new Map<string, string[]>();
  for (const spelling of [...marked.keys()].sort((a, b) => b.length - a.length)) {
    const bucket = byFirstChar.get(spelling[0]!);
    if (bucket) bucket.push(spelling);
    else byFirstChar.set(spelling[0]!, [spelling]);
  }
  // One pass over the original, copying in runs: `cursor` trails the last thing
  // written out, so what the scrub substitutes in is never itself scanned — a
  // marker cannot be redacted again into a nest of markers, which is what a
  // secret sharing any text with `{{secret:` or with its own name would do.
  const scrub = (s: string) => {
    let out = "";
    let cursor = 0;
    for (let at = 0; at < s.length; ) {
      const hit = byFirstChar.get(s[at]!)?.find((spelling) => s.startsWith(spelling, at));
      if (hit === undefined) {
        at += 1;
        continue;
      }
      out += s.slice(cursor, at) + marked.get(hit);
      at += hit.length;
      cursor = at;
    }
    return cursor === 0 ? s : out + s.slice(cursor);
  };
  if (err instanceof Error) {
    err.message = scrub(err.message);
    if (err.stack) err.stack = scrub(err.stack);
    return err;
  }
  if (typeof err === "string") return scrub(err);
  return err;
}
