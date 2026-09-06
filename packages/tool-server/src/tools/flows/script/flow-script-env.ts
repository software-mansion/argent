/**
 * The rules an `env` map obeys wherever a flow supplies one: the flow file's
 * top-level `env:`, a `script` step's own `env:`, the `flow-execute` run-time
 * `env` parameter, and `flow-add-script`'s.
 *
 * One module because four channels feed one environment. An author who learns
 * that a numeric value must be quoted in a step map, or that `NODE_OPTIONS` is
 * refused there, must meet the same answer in the other three — and the
 * precedence the runner builds the child environment in is written down once,
 * in {@link mergeScriptEnv}, rather than at each site that layers a map.
 */

import type { SecretSourceOptions } from "@argent/configuration-core";
import { resolveSecretPlaceholders } from "../../../utils/secrets";
import {
  BASH_EXCHANGE_ENV_NAMES,
  PROTO_ENV_NAME,
  reservedScriptEnvName,
  reservedScriptEnvNamesForMessage,
  SCRIPT_ENV_NAME_PATTERN,
  type FlowScriptSecret,
} from "./flow-script-executor";

/**
 * Why `raw` is not a usable `env` map, as a clause that reads after the name of
 * the map holding it — `` `env` ${problem} ``. Null when the map is usable.
 *
 * Every rule here is a RELIABILITY rule: each names a shape that would let the
 * script run with a value silently missing or replaced. None of them is about
 * what a value holds — an `env` value is ordinary flow data, and argent does
 * not judge whether one looks like a credential.
 */
export function describeScriptEnvProblem(raw: unknown): string | null {
  // `env:` with nothing under it is a map with no entries, not a malformed one:
  // every entry commented out is an ordinary authoring state, and `env: {}`
  // beside it is accepted. Nothing is lost by taking it, which is the question
  // every other rule in this function answers.
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return (
      "must be a map of environment variable names to string values, e.g. " +
      "`env: { API_URL: https://api.example.com }`"
    );
  }
  // A YAML tag on the map builds something that is an object and is not an
  // array, yet holds no entries `Object.entries` can see: `!!omap` and `!!set`
  // resolve to a real Map and Set, `!!timestamp` to a Date. Left to the walk
  // below, such a map reports zero problems, the script runs with none of the
  // author's values, and the next recorded step serializes it back as `env: {}`
  // — deleting the entries from the file. Named here instead.
  if (!isPlainMap(raw)) {
    return (
      `is ${describeTaggedMap(raw)} rather than a plain map, so argent reads no entries from ` +
      "it — every name would be dropped and the script would run without them, silently. A " +
      "YAML tag is what builds one; remove it, e.g. " +
      "`env: { API_URL: https://api.example.com }`"
    );
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SCRIPT_ENV_NAME_PATTERN.test(name)) {
      return (
        `holds ${JSON.stringify(name)}, which is not an environment variable name — a name ` +
        `starts with a letter or "_" and continues with letters, digits or "_"`
      );
    }
    if (name === PROTO_ENV_NAME) {
      return (
        `holds ${PROTO_ENV_NAME}, which argent cannot carry: the operating system takes the ` +
        `name, but every merge on the way to the child copies the map through a plain object, ` +
        `where ${PROTO_ENV_NAME} is an accessor rather than an entry — the value would be ` +
        `dropped and the script would run without it, silently. Use a name of your own`
      );
    }
    const reserved = reservedScriptEnvName(name);
    if (reserved) {
      // The two bash exchange names are named apart from the rest, because
      // "steers the runner's own process" is true of them in a way an author
      // cannot see: they are FILES a `.sh` reads and writes, refused whichever
      // language this step runs, since a flow-level map applies to every step.
      const why = BASH_EXCHANGE_ENV_NAMES.includes(reserved)
        ? "names the file a `.sh` step exchanges its output document or its failure reason " +
          "through, so argent sets it and a script may not"
        : "steers the runner's own process";
      return (
        `holds ${reserved}, which ${why} and cannot be set for a ` +
        `script (reserved names: ${reservedScriptEnvNamesForMessage()})`
      );
    }
    if (typeof value !== "string") {
      return (
        `holds ${describeValueType(value)} for ${name} — an environment carries strings only, ` +
        `so quote the value`
      );
    }
    // The operating system carries an environment as NUL-terminated strings, so
    // this one cannot survive the trip either: Node refuses the whole `fork`
    // over it, and the step then errors on a message about the spawn rather
    // than about the map that caused it. Refused here, naming the key.
    if (value.includes("\0")) {
      return `holds a NUL character in the value of ${name}, which an environment cannot carry`;
    }
  }
  // Windows carries ONE variable per name however it is spelled, so two entries
  // of one map that differ only in case are two spellings of one variable —
  // with no precedence between them to appeal to, since precedence orders
  // LAYERS and these are one layer. `mergeScriptEnv` would then let insertion
  // order decide and drop the other, which is the outcome this function refuses
  // `__proto__` and a tagged map over.
  //
  // On a case-SENSITIVE host they are two variables and both reach the script,
  // so the rule is the platform's. A flow written on macOS that this refuses on
  // Windows is refused for the reason it would misbehave there.
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

/**
 * Whether the entry walk can read this map. A prototype-less object is one the
 * parser and `z.record` both produce, so it counts; anything with a class of
 * its own does not.
 */
function isPlainMap(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** What the tag built, and the tag that builds it. */
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

/**
 * The environment values a script step runs with, layered in the one order the
 * runner uses. A later map replaces an earlier one, and the host allowlist the
 * executor builds sits under all of them:
 *
 * 1. the root flow's `env`
 * 2. each active nested flow's `env`, outermost first
 * 3. the `flow-execute` run-time `env`
 * 4. the script step's own `env`
 *
 * A flow-level map is a DEFAULT at any depth, which is why the run-time map
 * outranks even the innermost fragment's. A step-level map is not a default: it
 * is part of that one invocation, so nothing outside it wins.
 */
export function mergeScriptEnv(
  ...maps: Array<Readonly<Record<string, string>> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  // Windows carries ONE variable per name however it is spelled, so two layers
  // spelling it differently are two layers setting the same thing and the order
  // above has to decide between them here. Keeping both left the child
  // environment to dedupe them by folding case, so ASCII order rather than this
  // list decided which value the script read. See the same account in
  // `buildChildEnv`.
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

/**
 * `env` with every `{{secret:NAME}}` replaced by its value, plus the secrets
 * that were substituted so the executor can keep them out of the step's failure
 * text — a `.mjs` throw, and the `$ARGENT_REASON` a `.sh` writes.
 *
 * Only that exact spelling is a placeholder, the one `PLACEHOLDER_RE` accepts:
 * lower-case `secret`, a colon, a name, no spaces. `{{ secret: NAME }}`,
 * `{{SECRET:NAME}}` and `{secret:NAME}` are ordinary text and reach the script
 * as written, the way any other value does. Argent does not detect
 * near-spellings; a typo is the author's to find.
 *
 * The chain is anchored at the run's project rather than at the tool server's
 * working directory, which is a snapshot from whatever spawned the server — an
 * editor sets it to `/` or `$HOME`. Left to the default, a project's own
 * `.argent/secrets.env` and `.env` would never be found, on exactly the hosts
 * where this feature is most used. It reads those files on EACH call, so a
 * secrets file applies without a server restart; the tool-server environment
 * does not work that way.
 */
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
      // Named, because the resolver only knows the placeholder: an author with
      // several env values needs to be told which one holds the unknown name.
      throw new Error(
        `env value ${name}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? { cause: err } : undefined
      );
    }
    resolved[name] = substituted.text;
    for (const secret of substituted.secrets) {
      if (!secrets.some((seen) => seen.name === secret.name)) secrets.push(secret);
    }
  }
  return { env: resolved, secrets };
}
