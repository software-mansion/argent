import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { MCP_BINARY_NAME, nodeSatisfiesEngines, type McpServerEntry } from "@argent/installer";
import { type DoctorCheck, check, home, samePath } from "./doctor-shared.js";
import { GLOBAL_SHIM_FIX, addToPathFix, findGlobalArgent, isOnPath } from "./doctor-install.js";
import { redactUrl } from "./doctor-tool-server.js";

// `argent doctor`: whether an editor's MCP entry starts argent, judged the way its runner starts it.

export interface EntryContext {
  scope: "project" | "global";
  projectRoot: string;
  cwd: string;
  globalOnPath: boolean;
  /** Why the `argent` on PATH fails to run from the project, when it does. */
  globalRunError?: string | null;
  /** That `argent`'s path, so an entry naming the same shim gets the same verdict. */
  globalBin?: string | null;
  localInstalled: boolean;
  /** Resolvable the way npx resolves it (Node resolution, ancestors included). */
  localResolvable?: boolean;
  /** Whether package.json declares @swmansion/argent, so installing brings it back. */
  localDeclared?: boolean;
  argentCmd: string;
  installCmd: string;
  /**
   * Claude Code's local scope. `argent init` removes only a stock `argent mcp`
   * entry there (or, after asking, one whose `argent` is gone from PATH), so
   * other broken entries need `claude mcp remove`.
   */
  claudeLocal?: boolean;
  /** Bin dir of a global install that is not on PATH. */
  offPathGlobalBin?: string | null;
  /** How the editor treats the entry's `cwd`; "expands" when unknown. */
  cwdSupport?: CwdSupport;
  /** Whether npm's global prefix has an `argent`, where `npx --no-install` looks; null when unknown. */
  npmGlobalHasArgent?: boolean | null;
  /** The project runs Yarn 2 or later, which has `yarn dlx` (Yarn 1 doesn't). */
  yarnBerry?: boolean;
  /** The directory the editor starts the command in; by default the project root or cwd, by scope. */
  spawnDir?: string;
  /** spawnDir is wherever the editor was started, which doctor's cwd stands in for. */
  spawnsInLaunchDir?: boolean;
  /** The editor expands a leading `~` in command, args and cwd (VS Code, Cursor). */
  expandsTilde?: boolean;
  /** The editor appends the entry's PATH to its own instead of replacing it (VS Code). */
  appendsPath?: boolean;
}

/**
 * expands: spawns in the cwd, with ${workspaceFolder} expanded (VS Code).
 * literal: spawns in the cwd as written (Gemini).
 * ignored: never reads it (Claude Code, Cursor, Zed).
 * absolute-only: a relative cwd resolves against the editor's own process dir (Kiro).
 */
export type CwdSupport = "expands" | "literal" | "ignored" | "absolute-only";

// `KEY=value` arguments (`env ARGENT_AUTH_TOKEN=… argent mcp`) that carry a secret.
const SECRET_ASSIGNMENT = /^(\w*(?:TOKEN|SECRET|PASSWORD|KEY)\w*)=.+$/i;

function redactArg(arg: string): string {
  if (SECRET_ASSIGNMENT.test(arg)) return arg.replace(SECRET_ASSIGNMENT, "$1=***");
  return /^\w+:\/\//.test(arg) ? redactUrl(arg) : arg;
}

export function formatEntry(entry: McpServerEntry): string {
  if (entry.url) return redactUrl(entry.url);
  return [entry.command, ...entry.args].map(redactArg).join(" ");
}

// `${VAR}` (Claude Code, Gemini), `${env:VAR}` (VS Code, Cursor), `{env:VAR}` (opencode).
const ENV_REFERENCE = /\$\{env:(\w+)\}|\$\{(\w+)\}|\{env:(\w+)\}/g;
// What is left after expansion, Gemini's bare `$VAR` included.
const UNRESOLVED_VARIABLE = /\$\{|\{env:|\$\w/;

/** An entry value with the editor variables this shell can fill in expanded. */
export function expandEnvReferences(value: string): string {
  return value.replace(
    ENV_REFERENCE,
    (match, a?: string, b?: string, c?: string) => process.env[(a ?? b ?? c)!] ?? match
  );
}

export function hasUnresolvedVariable(value: string): boolean {
  return UNRESOLVED_VARIABLE.test(value);
}

function expandTilde(value: string): string {
  return /^~($|[\\/])/.test(value) ? homedir() + value.slice(1) : value;
}

// The scoped package or its unscoped `argent` alias, optionally with a version.
const ARGENT_PACKAGE_ARG = /^(@swmansion\/)?argent(@.+)?$/;
const NPX_NO_INSTALL = new Set(["--no-install", "--no"]);
// Node options whose value is the next argument (`node -r dotenv/config cli.js mcp`).
const NODE_VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--env-file",
  "--env-file-if-exists",
  "-C",
  "--conditions",
  "--title",
  "--disable-warning",
  "--redirect-warnings",
  "--watch-path",
  "--input-type",
  "--dns-result-order",
  "--unhandled-rejections",
]);
// Env that changes which `argent` the editor's spawn finds: its PATH or a
// version manager's pin. Other keys (ARGENT_IOS_TEAM_ID, …) don't.
const RESOLUTION_ENV = /^(PATH|Path|MISE_|ASDF_|NODENV_|NVM_|VOLTA_|FNM_|N_PREFIX$)/;
const PATH_KEY = /^(PATH|Path)$/;

/** The package `npx -p <pkg>` / `yarn dlx -p <pkg>` / `--package=<pkg>` names. */
function packageOption(args: string[]): string | undefined {
  for (const [i, arg] of args.entries()) {
    if (arg === "-p" || arg === "--package") return args[i + 1];
    if (arg.startsWith("--package=")) return arg.slice("--package=".length);
  }
  return undefined;
}

function installFix(ctx: EntryContext): string {
  return ctx.localDeclared === false
    ? `Add @swmansion/argent to devDependencies, then ${ctx.installCmd}`
    : ctx.installCmd;
}

interface DevEngine {
  name?: unknown;
  version?: unknown;
  onFail?: unknown;
}

function nearestPackageJson(dir: string): string | null {
  let current = path.resolve(dir);
  while (!fs.existsSync(path.join(current, "package.json"))) {
    if (path.dirname(current) === current) return null;
    current = path.dirname(current);
  }
  return path.join(current, "package.json");
}

/**
 * npm exec (every npx) first checks the project's devEngines, and with onFail
 * "error" (the default) aborts with EBADDEVENGINES when this Node fails it.
 */
function npxBlockedByDevEngines(dir: string, cmd: string): DoctorCheck | null {
  const manifestPath = nearestPackageJson(dir);
  if (!manifestPath) return null;
  let runtime: unknown;
  try {
    runtime = (
      JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { devEngines?: { runtime?: unknown } }
    ).devEngines?.runtime;
  } catch {
    return null;
  }
  const nodeEngines = (Array.isArray(runtime) ? runtime : [runtime]).filter(
    (e): e is DevEngine => !!e && typeof e === "object" && (e as DevEngine).name === "node"
  );
  const ranges = nodeEngines
    .map((e) => e.version)
    .filter((v): v is string => typeof v === "string");
  const fails =
    ranges.length > 0 &&
    ranges.every((range) => nodeSatisfiesEngines(process.version, range) === false) &&
    nodeEngines.some((e) => (e.onFail ?? "error") === "error");
  if (!fails) return null;
  return check(
    "warn",
    `${cmd} — npm refuses npx here: devEngines wants Node ${ranges.join(" or ")}, this shell has ${process.version}`,
    {
      detail: home(manifestPath),
      fix: `Start the editor with a Node matching ${ranges.join(" or ")}, or set devEngines.runtime.onFail to "warn"`,
    }
  );
}

/** The script `node` runs: the first argument that is neither an option nor an option's value. */
function nodeScriptIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith("-")) return i;
    if (NODE_VALUE_OPTIONS.has(args[i]!)) i++;
  }
  return -1;
}

/** The command a `cmd /c …` wrapper runs, the form Claude Code's docs give for Windows. */
function unwrapCmdShell(entry: McpServerEntry): McpServerEntry | null {
  const name = entry.command.split(/[\\/]/).pop()!;
  if (!/^cmd(\.exe)?$/i.test(name)) return null;
  const at = entry.args.findIndex((a) => /^\/c$/i.test(a));
  const [command, ...args] = at === -1 ? [] : entry.args.slice(at + 1);
  return command ? { ...entry, command, args } : null;
}

/**
 * Will this MCP entry start? A command that resolves in this shell is fine;
 * one that doesn't is dead unless env that changes the lookup (an nvm PATH, a
 * version manager's pin) may fix it in the client. That is stricter than the
 * "provably dead" rule `init` prunes by (init-stale-config.ts), which spares
 * an entry with any custom env because removing it can't be undone. The CLI
 * dispatches on its first argument, so `mcp` must follow the argent binary,
 * script or package.
 */
export function classifyMcpEntry(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const cmd = formatEntry(entry);
  const result = classifyCommand(entry, ctx);
  if (!entry.switchedOffBy?.length) return result;
  const key = `\`${entry.switchedOffBy[0] === "enabled" ? "enabled: false" : "disabled: true"}\``;
  if (result.status === "ok" || result.status === "info") {
    return check("warn", `${cmd} — switched off in the editor`, {
      detail: key,
      fix: "Turn the argent server back on in the editor's MCP settings",
    });
  }
  // init leaves a switched-off entry untouched, so it can only repair one that is on.
  const fix = result.fix?.includes(`${ctx.argentCmd} init`)
    ? `Turn the argent server back on in the editor's MCP settings, then: ${result.fix}`
    : result.fix;
  // The editor never starts it, so its broken command is no error yet.
  return check("warn", `${result.label} (switched off in the editor)`, {
    detail: [key, result.detail].filter(Boolean).join(" · "),
    fix,
  });
}

function classifyCommand(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const cmd = formatEntry(entry);
  if (entry.url) return check("info", `${cmd} (remote MCP server, not verified)`);
  const reinit = ctx.claudeLocal
    ? `claude mcp remove -s local argent, then ${ctx.argentCmd} init`
    : `${ctx.argentCmd} init`;
  if (entry.command === "") {
    return check("warn", "argent entry exists but could not be parsed", { fix: reinit });
  }
  const wrapped = unwrapCmdShell(entry);
  if (wrapped) {
    const inner = classifyCommand(wrapped, ctx);
    return { ...inner, label: inner.label.replace(formatEntry(wrapped), cmd) };
  }
  const badArgs = (): DoctorCheck =>
    check("error", `${cmd} — doesn't start the MCP server (argent's command must be \`mcp\`)`, {
      fix: reinit,
    });
  const deadPath = (p: string): DoctorCheck =>
    check("error", `${cmd} — ${p} does not exist`, {
      fix: ctx.claudeLocal
        ? `Point the entry at an existing argent, or run ${reinit}`
        : `Point the entry at an existing argent, or remove it and run ${ctx.argentCmd} init`,
    });
  const resolveValue = (value: string) => {
    const expanded = expandEnvReferences(value);
    return ctx.expandsTilde ? expandTilde(expanded) : expanded;
  };
  const scopeBase = ctx.spawnDir ?? (ctx.scope === "project" ? ctx.projectRoot : ctx.cwd);
  const cwdSupport = ctx.cwdSupport ?? "expands";
  const rawCwd = cwdSupport === "ignored" ? undefined : entry.cwd;
  const entryCwd =
    rawCwd &&
    resolveValue(
      cwdSupport === "expands"
        ? rawCwd.replace(/\$\{workspace(Folder|Root)\}/g, ctx.projectRoot)
        : rawCwd
    );
  if (entryCwd && hasUnresolvedVariable(entryCwd)) {
    return check("info", `${cmd} (runs in ${entry.cwd}, an editor variable, not verified)`);
  }
  if (entryCwd && cwdSupport === "absolute-only" && !path.isAbsolute(entryCwd)) {
    return check(
      "info",
      `${cmd} (runs in ${entryCwd}, relative to the editor's own directory, not verified)`
    );
  }
  const base = entryCwd ? path.resolve(scopeBase, entryCwd) : scopeBase;
  if (entryCwd && !fs.existsSync(base)) {
    return check("error", `${cmd} — its cwd ${entryCwd} does not exist`, {
      fix: "Point the entry's cwd at an existing directory, or remove it",
    });
  }
  // The editor runs relative paths from where it was started: from the project
  // root they would resolve.
  const missing = (p: string, otherwise: DoctorCheck): DoctorCheck =>
    ctx.spawnsInLaunchDir &&
    !entryCwd &&
    !samePath(base, ctx.projectRoot) &&
    fs.existsSync(path.resolve(ctx.projectRoot, p))
      ? check("warn", `${cmd} — ${p} resolves only when the editor starts in the project root`, {
          detail: `relative to ${home(base)}, where doctor runs`,
          fix: `Start the editor from ${home(ctx.projectRoot)}, or use an absolute path in the entry`,
        })
      : otherwise;

  const command = resolveValue(entry.command);
  if (hasUnresolvedVariable(command)) {
    return check("info", `${cmd} (uses an editor variable, not verified)`);
  }
  const absolute = path.isAbsolute(command);
  const pathLike = absolute || /[\\/]/.test(command);
  const fileName = path.basename(command);
  const bare = process.platform === "win32" ? fileName.replace(/\.(cmd|exe)$/i, "") : fileName;

  if (pathLike && !fs.existsSync(path.resolve(base, command))) {
    return missing(command, deadPath(entry.command));
  }
  // The editor's spawn looks a bare command up on the entry's own PATH. POSIX
  // env names are case-sensitive: only Windows reads `Path` as PATH.
  const rawPath = entry.env?.PATH ?? (process.platform === "win32" ? entry.env?.Path : undefined);
  const envPath = rawPath === undefined ? undefined : expandEnvReferences(rawPath);
  const entryPath = envPath !== undefined && !hasUnresolvedVariable(envPath) ? envPath : null;
  const lookupPath =
    entryPath !== null && ctx.appendsPath
      ? [process.env.PATH, entryPath].filter(Boolean).join(path.delimiter)
      : entryPath;
  const notOnEntryPath = (): DoctorCheck | null =>
    !pathLike && lookupPath !== null && !isOnPath(command, lookupPath)
      ? check("error", `${cmd} — \`${command}\` is not on the PATH this entry sets`, {
          detail: entryPath!,
          fix: `Add ${command}'s bin dir to the entry's PATH, or use its absolute path`,
        })
      : null;
  if (bare === MCP_BINARY_NAME) {
    if (entry.args[0] !== "mcp") return badArgs();
    const resolutionKeys = Object.keys(entry.env ?? {}).filter((key) => RESOLUTION_ENV.test(key));
    const failingShim = (softened: boolean): DoctorCheck =>
      softened
        ? check("warn", `${cmd} — \`argent\` fails to run here without this entry's env`, {
            detail: ctx.globalRunError!,
          })
        : check("error", `${cmd} — \`argent\` fails to run here`, {
            detail: ctx.globalRunError!,
            fix: GLOBAL_SHIM_FIX,
          });
    const isFailingShim = (bin: string) => !!ctx.globalRunError && samePath(bin, ctx.globalBin);
    const onEntryPath = (): DoctorCheck => {
      const found = findGlobalArgent(entryPath!);
      if (!found) {
        return check("error", `${cmd} — \`argent\` is not on the PATH this entry sets`, {
          detail: entryPath!,
          fix: "Add argent's bin dir to the entry's PATH, or use argent's absolute path",
        });
      }
      // The entry's PATH found the shim itself; only a version manager's pin may still fix it.
      if (isFailingShim(found.bin)) {
        return failingShim(resolutionKeys.some((key) => !PATH_KEY.test(key)));
      }
      return check("ok", cmd, { detail: "found on the PATH the entry sets" });
    };

    if (pathLike) {
      return isFailingShim(path.resolve(base, command))
        ? failingShim(resolutionKeys.length > 0)
        : check("ok", cmd);
    }
    if (envPath !== undefined && entryPath === null) {
      return check("info", `${cmd} (sets PATH with an editor variable, not verified)`);
    }
    if (entryPath !== null && !ctx.appendsPath) return onEntryPath();
    if (ctx.globalRunError) return failingShim(resolutionKeys.length > 0);
    if (ctx.globalOnPath) return check("ok", cmd);
    if (entryPath !== null) return onEntryPath();
    if (resolutionKeys.length > 0) {
      return check("warn", `${cmd} — \`argent\` is not on this shell's PATH`, {
        detail: "its custom env may still make it resolve inside the editor",
      });
    }
    return check("error", `${cmd} — \`argent\` is not on PATH, so this entry can't start`, {
      fix: ctx.offPathGlobalBin
        ? addToPathFix(ctx.offPathGlobalBin)
        : "npm i -g @swmansion/argent (or npx @swmansion/argent init)",
    });
  }
  if (bare === "node") {
    // Node's own options (`--no-warnings`, `-r dotenv/config`) come before the script.
    const at = nodeScriptIndex(entry.args);
    const rawScript = at === -1 ? undefined : entry.args[at];
    if (!rawScript || entry.args[at + 1] !== "mcp") return badArgs();
    const noNode = notOnEntryPath();
    if (noNode) return noNode;
    const script = resolveValue(rawScript);
    if (hasUnresolvedVariable(script)) {
      return check("info", `${cmd} (uses an editor variable, not verified)`);
    }
    if (fs.existsSync(path.resolve(base, script))) return check("ok", cmd);
    const inProjectDeps =
      !path.isAbsolute(script) &&
      /node_modules[\\/]/.test(script) &&
      fs.existsSync(path.join(ctx.projectRoot, "package.json"));
    return missing(
      script,
      inProjectDeps
        ? check("error", `${cmd} — ${script} does not exist`, { fix: installFix(ctx) })
        : deadPath(script)
    );
  }
  if (bare === "npx" || bare === "yarn") {
    const startsMcp = entry.args.some(
      (a, i) => ARGENT_PACKAGE_ARG.test(a) && entry.args[i + 1] === "mcp"
    );
    if (!startsMcp) return badArgs();
    const noRunner = notOnEntryPath();
    if (noRunner) return noRunner;
    // `npx -y argent@latest mcp`, `yarn dlx @swmansion/argent mcp`: fetched on start.
    const fetches =
      (bare === "npx" && !entry.args.some((a) => NPX_NO_INSTALL.has(a))) ||
      (bare === "yarn" && entry.args[0] === "dlx");
    const pkg = packageOption(entry.args) ?? entry.args.find((a) => ARGENT_PACKAGE_ARG.test(a));
    const blocked = bare === "npx" ? npxBlockedByDevEngines(base, cmd) : null;
    if (fetches && pkg && ARGENT_PACKAGE_ARG.test(pkg)) {
      return bare === "yarn" && !ctx.yarnBerry
        ? check("info", `${cmd} (needs Yarn 2 or later, since Yarn 1 has no dlx; not verified)`)
        : (blocked ?? check("ok", cmd, { detail: "fetched from npm when the editor starts it" }));
    }
    const missingLocal = check("error", `${cmd} — no local @swmansion/argent to run`, {
      fix: installFix(ctx),
    });
    if (bare === "yarn") return ctx.localInstalled ? check("ok", cmd) : missingLocal;
    // npx resolves like Node (ancestors too); `--no-install` then falls back to
    // the argent in npm's global prefix (by either name), wherever PATH points.
    const runsLocal = ctx.localResolvable ?? ctx.localInstalled;
    const runsGlobal = !fetches && (ctx.npmGlobalHasArgent ?? ctx.globalOnPath);
    return runsLocal || runsGlobal ? (blocked ?? check("ok", cmd)) : missingLocal;
  }
  return check("info", `${cmd} (custom command, not verified)`);
}
