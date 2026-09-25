import * as fs from "node:fs";
import * as path from "node:path";
import { withNpmForce } from "./utils.js";

// How the `skills` CLI gets run. `bin` is what's spawned/exec'd — the
// absolute path the PATH scan found, so a same-named shim in the working
// directory is never picked up instead. `buildArgs` turns the plain `skills`
// argv into that bin's real argv (npx needs `--force`, pnpm needs a leading
// `dlx`), and `label` is a copy-pasteable command prefix for logs and
// manual-fallback hints (`${label} skills ...`).
export interface SkillsRunner {
  kind: "npx" | "pnpm";
  bin: string;
  buildArgs: (skillsArgs: string[]) => string[];
  label: string;
}

const WIN32_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// Pure PATH scan — no subprocess — so this is cheap enough to call on every
// skills invocation and easy to unit test with an injected PATH. Relative
// entries are skipped: they resolve against the working directory, which for
// a skills refresh is the project being configured.
function findOnPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  const isAbsolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  const dirs = pathValue.split(path.delimiter).filter((dir) => dir.length > 0 && isAbsolute(dir));

  if (platform === "win32") {
    const exts = (env.PATHEXT ?? WIN32_DEFAULT_PATHEXT).split(";").filter(Boolean);
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, bin + ext);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable — keep looking.
    }
  }
  return null;
}

// Which CLI runs `skills` commands. npx stays preferred whenever it's on
// PATH, so nothing changes for npm users. When Node is pnpm-managed and npm
// (so npx) was never installed, `argent init`/`update` used to fail the
// skills step with `spawn npx ENOENT` (#1206) — `pnpm dlx` runs the same
// `skills` CLI without needing npm. With neither present, keep today's npx
// failure mode; it's the clearest signal something's missing.
export function resolveSkillsRunner(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): SkillsRunner {
  const npx = findOnPath("npx", env, platform);
  if (npx) return { kind: "npx", bin: npx, buildArgs: withNpmForce, label: "npx" };
  const pnpm = findOnPath("pnpm", env, platform);
  if (pnpm) {
    return { kind: "pnpm", bin: pnpm, buildArgs: (args) => ["dlx", ...args], label: "pnpm dlx" };
  }
  return { kind: "npx", bin: "npx", buildArgs: withNpmForce, label: "npx" };
}

export interface SkillsCommand {
  file: string;
  args: string[];
  shell: boolean;
}

// Whitespace and cmd.exe metacharacters: an argument holding any is quoted.
const CMD_SPECIAL = /[\s"&|<>^()%!,;=]/;

function quoteForCmd(arg: string): string {
  return CMD_SPECIAL.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

// The process to start for a `skills` command. On Windows npx and pnpm are
// .cmd shims, which Node only starts through a shell (ENOENT or EINVAL
// otherwise), and a shell joins argv unescaped — so a path with a space would
// split. Build the quoted command line here and hand it over as one string.
export function skillsCommand(
  runner: SkillsRunner,
  skillsArgs: string[],
  platform: NodeJS.Platform = process.platform
): SkillsCommand {
  const args = runner.buildArgs(skillsArgs);
  if (platform !== "win32") return { file: runner.bin, args, shell: false };
  return { file: [runner.bin, ...args].map(quoteForCmd).join(" "), args: [], shell: true };
}
