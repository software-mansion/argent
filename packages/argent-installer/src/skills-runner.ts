import * as fs from "node:fs";
import * as path from "node:path";
import { withNpmForce } from "./utils.js";

// How the `skills` CLI gets run. `bin` is what's spawned/exec'd, `buildArgs`
// turns the plain `skills` argv into that bin's real argv (npx needs
// `--force`, pnpm needs a leading `dlx`), and `label` is a copy-pasteable
// command prefix for logs and manual-fallback hints (`${label} skills ...`).
export interface SkillsRunner {
  bin: string;
  buildArgs: (skillsArgs: string[]) => string[];
  label: string;
}

const WIN32_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

// Pure PATH scan — no subprocess — so this is cheap enough to call on every
// skills invocation and easy to unit test with an injected PATH.
function isOnPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);

  if (platform === "win32") {
    const exts = (env.PATHEXT ?? WIN32_DEFAULT_PATHEXT).split(";").filter(Boolean);
    return dirs.some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, bin + ext))));
  }

  return dirs.some((dir) => {
    const candidate = path.join(dir, bin);
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
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
  if (isOnPath("npx", env, platform)) {
    return { bin: "npx", buildArgs: withNpmForce, label: "npx" };
  }
  if (isOnPath("pnpm", env, platform)) {
    return { bin: "pnpm", buildArgs: (args) => ["dlx", ...args], label: "pnpm dlx" };
  }
  return { bin: "npx", buildArgs: withNpmForce, label: "npx" };
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
// otherwise), and a shell joins argv unescaped - so a path with a space would
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
