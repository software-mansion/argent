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
 *
 * The pieces a SPACE split produce are matched between the quotes of an echoed
 * command line (`'staple' failed`) rather than globally. A passphrase's pieces
 * ARE ordinary words; matched anywhere in the message they blank every
 * `device`, `offline` or `battery` in a diagnostic that merely shares
 * vocabulary with the credential, and the agent loses the actionable half of
 * it. Whole values and `%` cuts travel unquoted in real messages too (HID/CDP
 * injection echoes no shell line), so those stay global — and where one
 * secret's whole value IS another's piece, the global registration wins (see
 * the upgrade in `redactSecretsFromError`).
 */
interface Spelling {
  text: string;
  /** Match only when immediately wrapped in single quotes in the message. */
  quotedOnly: boolean;
}

function secretSpellings(value: string): Spelling[] {
  const out = new Map<string, Spelling>();
  const add = (piece: string, quotedOnly: boolean) => {
    if (!piece) return;
    if (piece !== value && piece.length < MIN_REDACTED_PIECE) return;
    for (const text of [piece, piece.replaceAll("'", `'\\''`)]) {
      if (!out.has(text)) out.set(text, { text, quotedOnly });
    }
  };
  add(value, false);
  for (const segment of percentSegments(value)) add(segment, false);
  for (const word of value.split(" ")) {
    if (word !== value) {
      add(word, true);
      for (const segment of percentSegments(word)) add(segment, true);
    }
  }
  return [...out.values()];
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
  const marked = new Map<string, string>();
  const quotedOnly = new Set<string>();
  for (const { name, value } of secrets) {
    if (!value) continue;
    for (const spelling of secretSpellings(value)) {
      if (!marked.has(spelling.text)) {
        marked.set(spelling.text, `${SECRET_PLACEHOLDER_MARKER}${name}}}`);
        if (spelling.quotedOnly) quotedOnly.add(spelling.text);
      } else if (!spelling.quotedOnly) {
        // Another secret's whole value or `%` cut IS this piece. That text can
        // then be an unquoted echo of the other secret, so matching reverts to
        // global rather than staying gated to a quoting context it never
        // travelled through — under the global owner's name, since any given
        // occurrence is as likely to be its value as this piece.
        quotedOnly.delete(spelling.text);
        marked.set(spelling.text, `${SECRET_PLACEHOLDER_MARKER}${name}}}`);
      }
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
      const hit = byFirstChar.get(s[at]!)?.find(
        (spelling) =>
          s.startsWith(spelling, at) &&
          (!quotedOnly.has(spelling) ||
            // A space-split piece counts only as the echoed argument it is:
            // wrapped in the single quotes of a shell line. The same word
            // standing in the diagnostic's own prose stays readable.
            (s[at - 1] === "'" && s[at + spelling.length] === "'"))
      );
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
