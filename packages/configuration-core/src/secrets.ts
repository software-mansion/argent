import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { findProjectRoot } from "./flags.js";
import { resolveHomeDir, type ConfigPathOptions } from "./paths.js";

/**
 * Where `{{secret:NAME}}` values come from. The placeholder mechanism itself
 * lives in the tool-server's `secrets.ts`; this module owns only what NAME is
 * worth here.
 *
 * Sources are read fresh on every resolution, so editing a file takes effect
 * with no server restart — an editor-hosted tool-server inherits the
 * environment its editor was launched with, so an `ARGENT_SECRET_<NAME>`
 * variable alone would mean restarting the editor to add a secret.
 *
 * An agent composes the tool call, so whatever is reachable through
 * `{{secret:…}}` is exfiltratable by a prompt-injected agent (type it into a
 * field, read the field back). What argent may type therefore stays an
 * allowlist the user wrote deliberately, one rule per kind of file:
 *
 * - A **dedicated** file (`.argent/secrets.env`) exists for no other purpose,
 *   so the file *is* the allowlist: every key is exposed. An `ARGENT_SECRET_`
 *   prefix is redundant there and stripped, so both spellings name one secret.
 *
 * - A **shared** file the app also uses (`.env`, `.env.local`) exposes only its
 *   `ARGENT_SECRET_`-prefixed keys; the rest is unrelated application config
 *   argent must not be able to type. Adding the prefix to one line is the
 *   deliberate act that exposes it.
 *
 * Project sources sit under the project root discovered from the tool-server's
 * cwd, and are skipped when the cwd is not inside a project rather than
 * anchored at an arbitrary directory. The global scope (`~/.argent/secrets.env`)
 * needs no discovery and so always works.
 */

/** The mandatory prefix for a secret exposed through a shared environment or file. */
export const SECRET_ENV_PREFIX = "ARGENT_SECRET_";

/** Basename of the dedicated secrets file, inside a scope's `.argent` directory. */
const SECRETS_FILE_NAME = "secrets.env";

/**
 * Shared dotenv files in the project root, highest precedence first.
 * `.env.local` wins by the usual convention that it holds uncommitted
 * per-machine overrides — the natural home for a personal test account.
 */
const SHARED_ENV_FILES = [".env.local", ".env"] as const;

/**
 * The identifier grammar `{{secret:…}}` itself accepts, so a key dotenv
 * tolerates but the placeholder could never reference (dots, dashes) is not
 * advertised as available.
 */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a file's keys map to secret names. See the module comment. */
type FileExposure = "dedicated" | "shared";

/** One resolved source, with the diagnostics an unknown-name error reports. */
export interface SecretSource {
  /** Where this source came from, for diagnostics — never its values. */
  label: string;
  /** The environment and a client's secrets are always present; a file may not be. */
  kind: "env" | "file" | "client";
  /** False only for a file that is not there. */
  present: boolean;
  /** The secret names it defines, sorted. */
  names: string[];
  /** Values by name; empty when the source is absent or exposes nothing. */
  values: Map<string, string>;
  /**
   * Set on a *present* source that exposes nothing because of the prefix rule.
   * The error message has to explain that case or the user assumes the file was
   * ignored.
   */
  needsPrefix?: boolean;
}

/** Options for locating the scopes; `cwd`/`homeDir` let tests sandbox them. */
export interface SecretSourceOptions extends ConfigPathOptions {
  /** Process environment to read `ARGENT_SECRET_*` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function envSource(env: NodeJS.ProcessEnv): SecretSource {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(SECRET_ENV_PREFIX)) continue;
    const name = key.slice(SECRET_ENV_PREFIX.length);
    if (SECRET_NAME_RE.test(name)) values.set(name, value);
  }
  return {
    label: `environment (${SECRET_ENV_PREFIX}*)`,
    kind: "env",
    present: true,
    names: [...values.keys()].sort(),
    values,
  };
}

/**
 * Read one dotenv file into a source. A missing, unreadable, or directory path
 * degrades to an absent source rather than throwing: a broken secrets file must
 * not take down every typing call, and a later source in the chain may hold the
 * name.
 *
 * Absence is probed with a non-throwing `stat` rather than left to the read's
 * ENOENT, because most sources are absent on most calls and throwing costs far
 * more than the probe. The read stays wrapped anyway: `stat` cannot rule out a
 * directory, a permission error, or a file deleted between the two calls.
 */
function fileSource(filePath: string, exposure: FileExposure): SecretSource {
  const label = filePath;
  const absent: SecretSource = {
    label,
    kind: "file",
    present: false,
    names: [],
    values: new Map(),
  };
  if (!fs.statSync(filePath, { throwIfNoEntry: false })) return absent;
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return absent;
  }

  const values = new Map<string, string>();
  let skippedUnprefixed = false;
  // dotenv owns the grammar: export prefixes, quoted values containing `=`,
  // multi-line quoted values.
  for (const [key, value] of Object.entries(parseDotenv(content))) {
    const prefixed = key.startsWith(SECRET_ENV_PREFIX);
    if (exposure === "shared" && !prefixed) {
      skippedUnprefixed = true;
      continue;
    }
    // A dedicated file accepts both spellings for one secret.
    const name = prefixed ? key.slice(SECRET_ENV_PREFIX.length) : key;
    if (SECRET_NAME_RE.test(name)) values.set(name, value);
  }

  return {
    label,
    kind: "file",
    present: true,
    names: [...values.keys()].sort(),
    values,
    ...(values.size === 0 && skippedUnprefixed ? { needsPrefix: true } : {}),
  };
}

/**
 * The ordered source chain for this host, read fresh. First match wins, so the
 * environment overrides every file (a CI job's secret beats a stale checked-out
 * file) and the project overrides the user's global file.
 *
 * Paths are deduplicated because a project rooted at the home directory itself
 * makes the project and global secrets files one file, which would then be
 * reported twice in every diagnostic.
 */
export function secretSources(options: SecretSourceOptions = {}): SecretSource[] {
  const sources: SecretSource[] = [envSource(options.env ?? process.env)];

  const projectRoot = findProjectRoot(options.cwd ?? process.cwd());
  const filePaths: Array<{ path: string; exposure: FileExposure }> = [];
  if (projectRoot) {
    filePaths.push({
      path: path.join(projectRoot, ".argent", SECRETS_FILE_NAME),
      exposure: "dedicated",
    });
    for (const name of SHARED_ENV_FILES) {
      filePaths.push({ path: path.join(projectRoot, name), exposure: "shared" });
    }
  }
  filePaths.push({
    path: path.join(resolveHomeDir(options), ".argent", SECRETS_FILE_NAME),
    exposure: "dedicated",
  });

  const seen = new Set<string>();
  for (const entry of filePaths) {
    const resolved = path.resolve(entry.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    sources.push(fileSource(resolved, entry.exposure));
  }
  return sources;
}

/**
 * The secrets an argent client sent with one call, as the first source of the
 * tool-server's chain for that call. See `argent enable forward-secrets`.
 */
export function clientSecretSource(values: ReadonlyMap<string, string>): SecretSource {
  return {
    label: "secrets the argent client sent with this call",
    kind: "client",
    present: true,
    names: [...values.keys()].sort(),
    values: new Map(values),
  };
}

/** The wire form of `CLIENT_SECRETS_HEADER`: base64 of a JSON name-to-value object. */
export function encodeClientSecrets(values: ReadonlyMap<string, string>): string {
  return Buffer.from(JSON.stringify(Object.fromEntries(values)), "utf8").toString("base64");
}

/** Inverse of {@link encodeClientSecrets}; throws on anything it would not produce. */
export function decodeClientSecrets(header: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new Error("is not base64-encoded JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("is not a JSON object");
  }
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(parsed)) {
    if (!SECRET_NAME_RE.test(name)) throw new Error(`names an invalid secret "${name}"`);
    if (typeof value !== "string") throw new Error(`has a non-string value for ${name}`);
    values.set(name, value);
  }
  return values;
}

/** The value of `name` in the first source that defines it, else undefined. */
export function lookupSecret(name: string, sources: SecretSource[]): string | undefined {
  for (const source of sources) {
    const value = source.values.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A `{{secret:NAME}}` placeholder; group 1 is NAME. */
export const SECRET_PLACEHOLDER_RE = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Every NAME of a `{{secret:NAME}}` in `text`, in order, repeats included. */
export function placeholderNames(text: string): string[] {
  return Array.from(text.matchAll(SECRET_PLACEHOLDER_RE), (match) => match[1]!);
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
 * The secret a placeholder's `rawName` resolves to, with the name it resolved
 * under; `name` is `rawName` with any redundant prefix dropped when nothing
 * resolves.
 */
export function lookupPlaceholderSecret(
  rawName: string,
  sources: SecretSource[]
): { name: string; value: string | undefined } {
  const value = lookupSecret(rawName, sources);
  if (value !== undefined || !REDUNDANT_PREFIX_RE.test(rawName)) return { name: rawName, value };
  const name = rawName.replace(REDUNDANT_PREFIX_RE, "");
  return { name, value: lookupSecret(name, sources) };
}

/** Every name any source defines, deduplicated and sorted. Names only, never values. */
export function secretNames(sources: SecretSource[]): string[] {
  const names = new Set<string>();
  for (const source of sources) for (const name of source.names) names.add(name);
  return [...names].sort();
}

/**
 * The source chain rendered for an unknown-name error: one line per source,
 * enough to see *why* a name did not resolve (file not where you thought, or
 * found but its keys need the prefix) without disclosing a single value.
 */
export function describeSecretSources(sources: SecretSource[]): string {
  return sources
    .map((source, i) => {
      const count = `${source.names.length} secret${source.names.length === 1 ? "" : "s"}`;
      let state: string;
      if (!source.present) state = "not found";
      else if (source.needsPrefix) {
        state = `found, but no ${SECRET_ENV_PREFIX}* keys — only prefixed keys are exposed from a file the app shares`;
      } else state = source.kind === "file" ? `found, ${count}` : count;
      return `  ${i + 1}. ${source.label} — ${state}`;
    })
    .join("\n");
}

/**
 * Where to put a missing secret, in words. The global file leads because it
 * needs no project discovery and so cannot be wrong advice; project-local
 * alternatives follow.
 */
export function secretPlacementAdvice(name: string, options: SecretSourceOptions = {}): string {
  const globalFile = path.join(resolveHomeDir(options), ".argent", SECRETS_FILE_NAME);
  return (
    `To make it available, ask the user to add \`${name}=…\` to ${globalFile} ` +
    `(or to \`.argent/${SECRETS_FILE_NAME}\` in the project), add \`${SECRET_ENV_PREFIX}${name}=…\` ` +
    `to the project's .env / .env.local, or export ${SECRET_ENV_PREFIX}${name} in the tool-server's ` +
    `environment — never ask the user for the secret value itself. If this tool-server is reached ` +
    `through \`argent link\` or ARGENT_TOOLS_URL, the user can instead define it on the client's machine ` +
    `and run \`argent enable forward-secrets\` there; \`argent secrets\` there lists the sources the ` +
    `client reads, which this list leaves out.`
  );
}

/**
 * Where to define a secret that a client with `forward-secrets` on sent no
 * value for: on that client's machine, whose paths this host cannot know.
 */
export function clientSecretPlacementAdvice(name: string): string {
  return (
    `To make it available, ask the user to add \`${name}=…\` to ~/.argent/${SECRETS_FILE_NAME} on the ` +
    `client's machine (or to \`.argent/${SECRETS_FILE_NAME}\` in the project the client runs in), or ` +
    `to export ${SECRET_ENV_PREFIX}${name} before the client starts; \`argent secrets\` there lists ` +
    `the sources the client reads — never ask the user for the secret value itself.`
  );
}
