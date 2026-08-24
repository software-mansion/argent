import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { findProjectRoot } from "./flags.js";
import { resolveHomeDir, type ConfigPathOptions } from "./paths.js";

/**
 * Where `{{secret:NAME}}` values come from.
 *
 * The placeholder mechanism itself lives in the tool-server's `secrets.ts`
 * (it is the typing tools' concern, not configuration's); this module owns the
 * only question it delegates — *what is NAME worth here*. Originally that was a
 * single source, the `ARGENT_SECRET_<NAME>` environment variable, which is
 * CI-native but poor ergonomics interactively: an editor-hosted tool-server
 * inherits the environment its editor was launched with, so exporting a
 * variable means restarting the editor, and there is nowhere to write a
 * credential down that survives a reboot.
 *
 * So a name now resolves through an ordered chain of sources — the environment
 * first, then dotenv files — read fresh on every resolution, so editing a file
 * takes effect on the next keystroke with no server restart. This mirrors the
 * runtime-read design the rest of the configuration surface already uses (see
 * `configuredAdditionalDeviceSets`).
 *
 * ── What each source exposes ──────────────────────────────────────────
 *
 * The security property the env prefix bought must survive the new sources: an
 * agent composes the tool call, so whatever is reachable through
 * `{{secret:…}}` is exfiltratable by a prompt-injected agent (type it into a
 * field, read the field back). "Which values may argent type" therefore has to
 * stay an allowlist the user wrote deliberately — never "everything on the
 * host", and never "everything in the app's .env".
 *
 * Two kinds of file, one rule each:
 *
 * - A **dedicated** argent secrets file (`.argent/secrets.env`) exists for no
 *   other purpose, so the file *is* the allowlist: every key in it is a secret
 *   argent may type. An `ARGENT_SECRET_` prefix is accepted but redundant there
 *   and stripped, so both spellings name the same secret.
 *
 * - A **shared** file the app also uses (`.env`, `.env.local`) exposes only its
 *   `ARGENT_SECRET_`-prefixed keys — exactly the rule that governs the process
 *   environment, and for exactly the same reason: the file holds unrelated
 *   application config (API keys, tokens) that argent must not be able to type.
 *   Adding `ARGENT_SECRET_` to one line is the deliberate act that exposes it.
 *
 * ── Scopes ────────────────────────────────────────────────────────────
 *
 * Project sources sit under the project root discovered from the tool-server's
 * cwd — the same walk-up (`.argent` / `.git` / `package.json`) every other
 * project-scoped configuration uses. When the cwd is not inside a project at
 * all, project sources are skipped rather than anchored at an arbitrary
 * directory. The global scope (`~/.argent/secrets.env`) needs no discovery and
 * is therefore the source that always works — including for a tool-server
 * whose cwd its editor set to `/`.
 */

/** The mandatory prefix for a secret exposed through a shared environment or file. */
export const SECRET_ENV_PREFIX = "ARGENT_SECRET_";

/** Basename of the dedicated secrets file, inside a scope's `.argent` directory. */
const SECRETS_FILE_NAME = "secrets.env";

/**
 * Shared dotenv files consulted in the project root, nearest-wins first.
 * `.env.local` precedes `.env` because that is the universal convention for
 * "my machine's overrides, not committed" — the natural home for a personal
 * test account.
 */
const SHARED_ENV_FILES = [".env.local", ".env"] as const;

/**
 * Secret names are restricted to the identifier grammar the placeholder itself
 * accepts, so a key dotenv tolerates but `{{secret:…}}` could never reference
 * (dots, dashes) is not advertised as available.
 */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a file's keys map to secret names. See the module comment. */
type FileExposure = "dedicated" | "shared";

/** One resolved source, with the diagnostics an unknown-name error reports. */
export interface SecretSource {
  /** Where this source came from, for diagnostics — never its values. */
  label: string;
  /** The environment is always there; a file may not be — see {@link present}. */
  kind: "env" | "file";
  /** Whether the source exists at all (a file that is not there). */
  present: boolean;
  /** The secret names it defines, sorted. */
  names: string[];
  /** Values by name. Empty when the source is absent or exposes nothing. */
  values: Map<string, string>;
  /**
   * Set on a *present* source that exposes nothing because of the prefix rule —
   * the "my .env has the value but argent can't see it" case, which the error
   * message has to explain or the user will assume the file was ignored.
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
 * not take down every typing call, and the chain's later sources may well hold
 * the name.
 *
 * Absence is probed with a non-throwing `stat` rather than left to the read's
 * ENOENT, because most sources are absent on most calls — a setup with only
 * `~/.argent/secrets.env` misses three of four every time a secret is typed —
 * and constructing the rejected Error (stack capture included) costs an order
 * of magnitude more than the probe: measured on a Pi 5, 40.6µs to throw versus
 * 3.0µs to stat. The read stays wrapped anyway: `stat` cannot rule out a
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
  // dotenv owns the grammar (export prefixes, quoted values containing `=`,
  // multi-line quoted values) — the same parser gather-workspace-data uses.
  for (const [key, value] of Object.entries(parseDotenv(content))) {
    const prefixed = key.startsWith(SECRET_ENV_PREFIX);
    if (exposure === "shared" && !prefixed) {
      skippedUnprefixed = true;
      continue;
    }
    // A dedicated file accepts both spellings; the prefix is redundant there.
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
 * Paths are deduplicated: when the cwd is a project rooted at the home
 * directory itself, the project and global secrets files are the same file, and
 * listing it twice would report it twice in every diagnostic.
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

/** The value of `name` in the first source that defines it, else undefined. */
export function lookupSecret(name: string, sources: SecretSource[]): string | undefined {
  for (const source of sources) {
    const value = source.values.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Every name any source defines, deduplicated and sorted. Names only, never values. */
export function secretNames(sources: SecretSource[]): string[] {
  const names = new Set<string>();
  for (const source of sources) for (const name of source.names) names.add(name);
  return [...names].sort();
}

/**
 * The source chain rendered for an unknown-name error: one line per source,
 * saying whether it exists and how many secrets it contributed — enough to see
 * *why* a name did not resolve (file not where you thought, or found but its
 * keys need the prefix) without disclosing a single value.
 */
export function describeSecretSources(sources: SecretSource[]): string {
  return sources
    .map((source, i) => {
      const count = `${source.names.length} secret${source.names.length === 1 ? "" : "s"}`;
      let state: string;
      if (!source.present) state = "not found";
      else if (source.needsPrefix) {
        state = `found, but no ${SECRET_ENV_PREFIX}* keys — only prefixed keys are exposed from a file the app shares`;
      } else state = source.kind === "env" ? count : `found, ${count}`;
      return `  ${i + 1}. ${source.label} — ${state}`;
    })
    .join("\n");
}

/**
 * Where to put a secret that is missing, in words. Named after the scope that
 * always works: the global file needs no project discovery, so it is the advice
 * that cannot be wrong, with the project-local alternatives listed after it.
 */
export function secretPlacementAdvice(name: string, options: SecretSourceOptions = {}): string {
  const globalFile = path.join(resolveHomeDir(options), ".argent", SECRETS_FILE_NAME);
  return (
    `To make it available, ask the user to add \`${name}=…\` to ${globalFile} ` +
    `(or to \`.argent/${SECRETS_FILE_NAME}\` in the project), add \`${SECRET_ENV_PREFIX}${name}=…\` ` +
    `to the project's .env / .env.local, or export ${SECRET_ENV_PREFIX}${name} in the tool-server's ` +
    `environment — never ask the user for the secret value itself.`
  );
}
