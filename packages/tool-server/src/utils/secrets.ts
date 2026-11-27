import { FAILURE_CODES } from "@argent/registry";
import { InvalidToolInputError } from "./capability";
import {
  clientSecretPlacementAdvice,
  clientSecretSource,
  describeSecretSources,
  lookupPlaceholderSecret,
  secretNames,
  secretPlacementAdvice,
  secretSources,
  SECRET_PLACEHOLDER_RE,
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
 * Replace every `{{secret:NAME}}` in `text` with its value. An unknown name
 * rejects with the *names* of available secrets and the sources consulted —
 * never a value — so an agent can self-correct.
 *
 * The source chain is built lazily and once per call: text with no placeholder
 * never touches the filesystem, and several placeholders resolve against one
 * snapshot. `clientSecrets` (a tool's `ctx.clientSecrets`) lead the chain.
 */
export function resolveSecretPlaceholders(
  text: string,
  options: SecretSourceOptions & { clientSecrets?: ReadonlyMap<string, string> } = {}
): ResolvedSecretText {
  const secrets: Array<{ name: string; value: string }> = [];
  let sources: SecretSource[] | undefined;
  const resolved = text.replace(SECRET_PLACEHOLDER_RE, (_placeholder, rawName: string) => {
    sources ??= [
      ...(options.clientSecrets ? [clientSecretSource(options.clientSecrets)] : []),
      ...secretSources(options),
    ];
    const { name, value } = lookupPlaceholderSecret(rawName, sources);
    if (value === undefined) {
      const names = secretNames(sources);
      // Only a client that forwards sends `clientSecrets`, an empty map included.
      const where = options.clientSecrets
        ? `the required secret ${name} was not provided: the argent client forwards its ` +
          `secrets to this tool-server and has no value for it, and no source on the machine ` +
          `running the tool-server defines it either`
        : `no source on the machine running the tool-server defines ${name}`;
      throw new InvalidToolInputError(
        `Unknown secret "${rawName}" — ${where}. ` +
          `Available secrets: ${names.length ? names.join(", ") : "(none)"}.\n` +
          `Sources consulted, first match wins:\n${describeSecretSources(sources)}\n` +
          (options.clientSecrets
            ? clientSecretPlacementAdvice(name)
            : secretPlacementAdvice(name, options)),
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
 * Shorter fragments would match ordinary text too often to redact by. Longer
 * ones still can (`postgres://` from a database URL) and are redacted anyway:
 * a marker where no secret was printed costs less than a leaked fragment.
 */
const MIN_FRAGMENT = 6;

/**
 * Replace each secret in `text` with `{{secret:NAME}}`: the whole value, and
 * any fragment of it at least {@link MIN_FRAGMENT} characters long, since what
 * reaches a log is often wrapped, truncated or cut by a size limit. A shorter
 * value only matches whole. Best effort: it knows the raw, URL-encoded and
 * JSON-escaped spellings, not every encoding a caller could apply.
 */
export function redactSecrets(
  text: string,
  secrets: ReadonlyArray<{ name: string; value: string }>
): string {
  return secretRedactor(secrets)(text);
}

export interface SecretRedactor {
  (text: string, opts?: { cut?: boolean }): string;
  /** Which secret owns each position of `text`; opaque, for {@link SecretRedactor.render}. */
  claims(text: string, opts?: { cut?: boolean }): Int32Array;
  /** `text` with each run of positions one secret owns replaced by its marker. */
  render(text: string, owner: Int32Array): string;
  readonly names: ReadonlySet<string>;
}

export interface SecretRedactorOptions {
  /**
   * For data an agent parses, such as network traffic, rather than a log it
   * reads: only whole values are found, in the spellings of
   * {@link spellingsOf} plus those of {@link dataSpellingsOf}. No fragment is
   * looked for inside the text, since a fragment of a password such as
   * `password1` is in every `"password"` key. A value shorter than
   * {@link MIN_FRAGMENT} counts only where it stands alone (see
   * {@link standsAlone}), so a PIN `4821` is not found in the id `14821`. A
   * marker already in the text is left as it is, so a second pass does not
   * nest markers. With `cut`, the longest start of a spelling that ends the
   * text is redacted, a start shorter than {@link MIN_FRAGMENT} only after a
   * character that is not a letter or a digit.
   */
  wholeValues?: boolean;
}

/**
 * {@link redactSecrets} with the secrets indexed once, for a caller that
 * redacts many strings. `cut` says the text ends where a size limit cut it: a
 * fragment of a secret shorter than {@link MIN_FRAGMENT} at the very end is
 * then redacted too, since the limit, not the script, decided where it stops.
 */
export function secretRedactor(
  secrets: ReadonlyArray<{ name: string; value: string }>,
  options: SecretRedactorOptions = {}
): SecretRedactor {
  const whole = options.wholeValues === true;
  // A lower index wins a contested position, so a value containing another (a
  // host inside a URL) is not split around the shorter one.
  const ordered = secrets
    .filter(({ value }) => value.length > 0)
    .sort((a, b) => b.value.length - a.value.length || (a.name < b.name ? -1 : +(a.name > b.name)));
  const none = ordered.length;
  const spellings = ordered.map(({ value }) => [
    ...(whole ? dataSpellingsOf(value) : spellingsOf(value)),
  ]);
  // Ids rise as entries are visited, so the first one a window records wins.
  const windows = new Map<string, number>();
  if (!whole)
    spellings.forEach((forms, id) => {
      for (const spelling of forms) {
        for (let i = 0; i + MIN_FRAGMENT <= spelling.length; i++) {
          const window = spelling.slice(i, i + MIN_FRAGMENT);
          if (!windows.has(window)) windows.set(window, id);
        }
      }
    });

  const wholeClaims = (
    text: string,
    cut: boolean,
    owner: Int32Array,
    claim: (from: number, to: number, id: number) => void
  ) => {
    spellings.forEach((forms, id) => {
      const short = ordered[id].value.length < MIN_FRAGMENT;
      for (const spelling of forms) {
        for (let at = text.indexOf(spelling); at !== -1; at = text.indexOf(spelling, at + 1)) {
          if (!short || standsAlone(text, at, at + spelling.length)) {
            claim(at, at + spelling.length, id);
          }
        }
        if (!cut) continue;
        for (let n = Math.min(spelling.length - 1, text.length); n > 0; n--) {
          const at = text.length - n;
          if (!text.endsWith(spelling.slice(0, n))) continue;
          if ((n >= MIN_FRAGMENT && !short) || startsAlone(text, at)) claim(at, text.length, id);
          break;
        }
      }
    });
    // A marker already in the text keeps its characters, whichever value they spell.
    for (const marker of text.matchAll(MARKER_IN_TEXT_RE)) {
      owner.fill(none, marker.index, marker.index + marker[0].length);
    }
  };

  const claims = (text: string, opts: { cut?: boolean } = {}): Int32Array => {
    const owner = new Int32Array(text.length).fill(none);
    if (none === 0) return owner;
    const claim = (from: number, to: number, id: number) => {
      for (let i = from; i < to; i++) owner[i] = Math.min(owner[i], id);
    };
    if (whole) {
      wholeClaims(text, opts.cut === true, owner, claim);
      return owner;
    }
    spellings.forEach((forms, id) => {
      for (const spelling of forms) {
        if (spelling.length >= MIN_FRAGMENT) continue;
        for (let at = text.indexOf(spelling); at !== -1; at = text.indexOf(spelling, at + 1)) {
          claim(at, at + spelling.length, id);
        }
      }
    });
    if (windows.size > 0) {
      for (let p = 0; p + MIN_FRAGMENT <= text.length; p++) {
        const id = windows.get(text.slice(p, p + MIN_FRAGMENT));
        if (id !== undefined) claim(p, p + MIN_FRAGMENT, id);
      }
    }
    if (opts.cut) {
      spellings.forEach((forms, id) => {
        for (const spelling of forms) {
          const longest = Math.min(MIN_FRAGMENT - 1, spelling.length - 1, text.length);
          for (let n = longest; n > 0; n--) {
            if (text.endsWith(spelling.slice(0, n))) {
              claim(text.length - n, text.length, id);
              break;
            }
          }
        }
      });
    }
    // A window can begin or end inside a surrogate pair; redact the whole
    // character rather than leave half of it.
    for (let i = 0; i + 1 < text.length; i++) {
      const high = text.charCodeAt(i);
      const low = text.charCodeAt(i + 1);
      if (high < 0xd800 || high > 0xdbff || low < 0xdc00 || low > 0xdfff) continue;
      const id = Math.min(owner[i], owner[i + 1]);
      owner[i] = id;
      owner[i + 1] = id;
      i++;
    }
    return owner;
  };

  const render = (text: string, owner: Int32Array): string => {
    let out = "";
    let copied = 0;
    for (let at = 0; at < text.length; at++) {
      if (owner[at] === none) continue;
      // By name, not entry: a caller may pass several spellings of one secret.
      const { name } = ordered[owner[at]];
      let end = at + 1;
      while (end < text.length && ordered[owner[end]]?.name === name) end++;
      out += `${text.slice(copied, at)}${SECRET_PLACEHOLDER_MARKER}${name}}}`;
      copied = end;
      at = end - 1;
    }
    return copied === 0 ? text : out + text.slice(copied);
  };

  const redact = ((text: string, opts?: { cut?: boolean }) =>
    none === 0 || text.length === 0 ? text : render(text, claims(text, opts))) as SecretRedactor;
  return Object.assign(redact, {
    claims,
    render,
    names: new Set(ordered.map(({ name }) => name)),
  });
}

/** `{{secret:NAME}}` as text, for {@link SecretRedactorOptions.wholeValues}. */
const MARKER_IN_TEXT_RE = /\{\{secret:[A-Za-z_][A-Za-z0-9_]*\}\}/g;

function isAsciiAlnum(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * Whether `text[from, to)` has no ASCII letter or digit on either side. An
 * escape right before it (`\n`, `\u0026`, `%20`) stands for a character that is
 * not one, so it counts as a boundary too: `"code\n4821"` holds the value
 * `4821`. A letter outside ASCII is not a letter here.
 */
function standsAlone(text: string, from: number, to: number): boolean {
  return startsAlone(text, from) && (to === text.length || !isAsciiAlnum(text.charCodeAt(to)));
}

function startsAlone(text: string, from: number): boolean {
  if (from === 0 || !isAsciiAlnum(text.charCodeAt(from - 1))) return true;
  const before = text.slice(Math.max(0, from - 6), from);
  return /(?:\\[bfnrt]|\\u[0-9a-fA-F]{4}|%[0-9a-fA-F]{2})$/.test(before);
}

/**
 * The spellings of {@link spellingsOf} and those the common client stacks
 * write into a request: `/` written `\/` (Android's org.json, Foundation's
 * JSONSerialization), `<`, `>`, `&`, `=`, `'` and every character outside
 * ASCII written `\u` and 4 lowercase hex digits (Gson's default, Python's
 * json), and a form body (`URLSearchParams`, OkHttp's `FormBody`), which
 * percent-encodes all but letters, digits and `*-._` and writes a space `+`.
 */
function dataSpellingsOf(value: string): Set<string> {
  const spellings = spellingsOf(value);
  const json = JSON.stringify(value).slice(1, -1);
  spellings.add(json.replaceAll("/", "\\/"));
  spellings.add(
    json.replace(
      /[<>&='\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
    )
  );
  spellings.add(new URLSearchParams([["", value]]).toString().slice(1));
  return spellings;
}

function spellingsOf(value: string): Set<string> {
  const spellings = new Set([value, JSON.stringify(value).slice(1, -1)]);
  try {
    spellings.add(encodeURIComponent(value));
  } catch {
    // A lone surrogate has no URL encoding, so nothing can print one.
  }
  return spellings;
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
  // A shell-quoted command line carries each `'` of a value as `'\''`.
  const forms = secrets.flatMap((secret) => {
    const quoted = secret.value.replaceAll("'", "'\\''");
    return quoted === secret.value ? [secret] : [secret, { name: secret.name, value: quoted }];
  });
  const scrub = (s: string) => redactSecrets(s, forms);
  if (err instanceof Error) {
    err.message = scrub(err.message);
    if (err.stack) err.stack = scrub(err.stack);
    return err;
  }
  if (typeof err === "string") return scrub(err);
  return err;
}
