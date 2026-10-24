import * as fs from "node:fs";
import * as path from "node:path";
import { MCP_BINARY_NAME, type McpServerEntry } from "@argent/installer";
import { type DoctorCheck, check, home, samePath } from "./doctor-shared.js";
import { GLOBAL_SHIM_FIX, findGlobalArgent } from "./doctor-install.js";

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
  argentCmd: string;
  installCmd: string;
  /** Claude Code's local scope, which `argent init` never writes or clears. */
  claudeLocal?: boolean;
  /** Bin dir of a global install that is not on PATH. */
  offPathGlobalBin?: string | null;
}

export function formatEntry(entry: McpServerEntry): string {
  return [entry.command, ...entry.args].join(" ");
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

/** The package `npx -p <pkg>` / `yarn dlx -p <pkg>` / `--package=<pkg>` names. */
function packageOption(args: string[]): string | undefined {
  for (const [i, arg] of args.entries()) {
    if (arg === "-p" || arg === "--package") return args[i + 1];
    if (arg.startsWith("--package=")) return arg.slice("--package=".length);
  }
  return undefined;
}

/** The script `node` runs: the first argument that is neither an option nor an option's value. */
function nodeScriptIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith("-")) return i;
    if (NODE_VALUE_OPTIONS.has(args[i]!)) i++;
  }
  return -1;
}

/**
 * Will this MCP entry start? Mirrors the "provably dead" rule `init` uses to
 * prune stale entries (init-stale-config.ts): a command that resolves in this
 * shell is fine; one that doesn't is dead unless custom env may fix it in the
 * client (an nvm PATH, classically). The CLI dispatches on its first argument,
 * so `mcp` must follow the argent binary, script or package.
 */
export function classifyMcpEntry(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const cmd = formatEntry(entry);
  const result = classifyCommand(entry, ctx);
  if (entry.switchedOffBy?.length && (result.status === "ok" || result.status === "info")) {
    return check("warn", `${cmd} — switched off in the editor`, {
      detail: `\`${entry.switchedOffBy[0] === "enabled" ? "enabled: false" : "disabled: true"}\``,
      fix: "Turn the argent server back on in the editor's MCP settings",
    });
  }
  return result;
}

function classifyCommand(entry: McpServerEntry, ctx: EntryContext): DoctorCheck {
  const cmd = formatEntry(entry);
  const reinit = ctx.claudeLocal
    ? `claude mcp remove -s local argent, then ${ctx.argentCmd} init`
    : `${ctx.argentCmd} init`;
  if (entry.command === "") {
    return check("warn", "argent entry exists but could not be parsed", { fix: reinit });
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
  const scopeBase = ctx.scope === "project" ? ctx.projectRoot : ctx.cwd;
  // An entry's own cwd: VS Code and Cursor expand ${workspaceFolder} in it.
  const entryCwd = entry.cwd?.replace(/\$\{workspace(Folder|Root)\}/g, ctx.projectRoot);
  if (entryCwd?.includes("${")) {
    return check("info", `${cmd} (runs in ${entry.cwd}, an editor variable, not verified)`);
  }
  const base = entryCwd ? path.resolve(scopeBase, entryCwd) : scopeBase;
  const absolute = path.isAbsolute(entry.command);
  const pathLike = absolute || /[\\/]/.test(entry.command);
  const fileName = path.basename(entry.command);
  const bare = process.platform === "win32" ? fileName.replace(/\.(cmd|exe)$/i, "") : fileName;

  if (entry.command.includes("${")) {
    return check("info", `${cmd} (uses an editor variable, not verified)`);
  }
  if (pathLike && !fs.existsSync(path.resolve(base, entry.command))) {
    return deadPath(entry.command);
  }
  if (bare === MCP_BINARY_NAME) {
    if (entry.args[0] !== "mcp") return badArgs();
    const envPath = entry.env?.PATH ?? entry.env?.Path;
    const mayResolve = Object.keys(entry.env ?? {}).some((key) => RESOLUTION_ENV.test(key));
    const failingShim = (): DoctorCheck =>
      mayResolve
        ? check("warn", `${cmd} — \`argent\` fails to run here without this entry's env`, {
            detail: ctx.globalRunError!,
          })
        : check("error", `${cmd} — \`argent\` fails to run here`, {
            detail: ctx.globalRunError!,
            fix: GLOBAL_SHIM_FIX,
          });
    if (pathLike) {
      const isFailingShim =
        !!ctx.globalRunError && samePath(path.resolve(base, entry.command), ctx.globalBin);
      return isFailingShim ? failingShim() : check("ok", cmd);
    }
    // The editor's spawn looks the command up on the entry's own PATH.
    if (envPath !== undefined && !envPath.includes("${")) {
      return findGlobalArgent(envPath)
        ? check("ok", cmd, { detail: "found on the PATH the entry sets" })
        : check("error", `${cmd} — \`argent\` is not on the PATH this entry sets`, {
            detail: envPath,
            fix: "Add argent's bin dir to the entry's PATH, or use argent's absolute path",
          });
    }
    if (ctx.globalRunError) return failingShim();
    if (ctx.globalOnPath) return check("ok", cmd);
    if (mayResolve) {
      return check("warn", `${cmd} — \`argent\` is not on this shell's PATH`, {
        detail: "its custom env may still make it resolve inside the editor",
      });
    }
    return check("error", `${cmd} — \`argent\` is not on PATH, so this entry can't start`, {
      fix: ctx.offPathGlobalBin
        ? `Add ${home(ctx.offPathGlobalBin)} to PATH`
        : "npm i -g @swmansion/argent (or npx @swmansion/argent init)",
    });
  }
  if (bare === "node") {
    // Node's own options (`--no-warnings`, `-r dotenv/config`) come before the script.
    const at = nodeScriptIndex(entry.args);
    const script = at === -1 ? undefined : entry.args[at];
    if (!script || entry.args[at + 1] !== "mcp") return badArgs();
    if (script.includes("${")) {
      return check("info", `${cmd} (uses an editor variable, not verified)`);
    }
    if (fs.existsSync(path.resolve(base, script))) return check("ok", cmd);
    const inProjectDeps =
      !path.isAbsolute(script) &&
      /node_modules[\\/]/.test(script) &&
      fs.existsSync(path.join(ctx.projectRoot, "package.json"));
    return inProjectDeps
      ? check("error", `${cmd} — ${script} does not exist`, { fix: ctx.installCmd })
      : deadPath(script);
  }
  if (bare === "npx" || bare === "yarn") {
    const startsMcp = entry.args.some(
      (a, i) => ARGENT_PACKAGE_ARG.test(a) && entry.args[i + 1] === "mcp"
    );
    if (!startsMcp) return badArgs();
    // `npx -y argent@latest mcp`, `yarn dlx @swmansion/argent mcp`: fetched on start.
    const fetches =
      (bare === "npx" && !entry.args.some((a) => NPX_NO_INSTALL.has(a))) ||
      (bare === "yarn" && entry.args[0] === "dlx");
    const pkg = packageOption(entry.args) ?? entry.args.find((a) => ARGENT_PACKAGE_ARG.test(a));
    if (fetches && pkg && ARGENT_PACKAGE_ARG.test(pkg)) {
      return check("ok", cmd, { detail: "fetched from npm when the editor starts it" });
    }
    const missing = check("error", `${cmd} — no local @swmansion/argent to run`, {
      fix: ctx.installCmd,
    });
    if (bare === "yarn") return ctx.localInstalled ? check("ok", cmd) : missing;
    // npx resolves like Node (ancestors too); `--no-install` then falls back to
    // an `argent` on PATH.
    const runsLocal = ctx.localResolvable ?? ctx.localInstalled;
    const runsGlobal = !fetches && ctx.globalOnPath && entry.args.includes(MCP_BINARY_NAME);
    return runsLocal || runsGlobal ? check("ok", cmd) : missing;
  }
  return check("info", `${cmd} (custom command, not verified)`);
}
