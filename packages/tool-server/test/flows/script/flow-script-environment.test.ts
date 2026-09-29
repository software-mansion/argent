import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_SCRIPT_HEAP_LIMIT_MB } from "@argent/configuration-core";
import {
  describeScriptEnvProblem,
  mergeScriptEnv,
} from "../../../src/tools/flows/script/flow-script-env";
import {
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";
import { resolveHostBash } from "../../helpers/host-bash";

const workspaces: ScriptWorkspace[] = [];
const restoreEnv: Array<() => void> = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("env");
  workspaces.push(ws);
  return ws;
}

function withEnv(name: string, value: string): void {
  const before = process.env[name];
  restoreEnv.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
  process.env[name] = value;
}

async function onPlatform<T>(platform: NodeJS.Platform, body: () => Promise<T>): Promise<T> {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
}

async function asWindows<T>(body: () => Promise<T>): Promise<T> {
  return onPlatform("win32", body);
}

async function asPosix<T>(body: () => Promise<T>): Promise<T> {
  return onPlatform("linux", body);
}

function withoutEnv(name: string): void {
  const before = process.env[name];
  restoreEnv.push(() => {
    if (before !== undefined) process.env[name] = before;
  });
  delete process.env[name];
}

afterEach(() => {
  while (restoreEnv.length) restoreEnv.pop()!();
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

function reporter(names: string[]): string {
  return `output.env = {}; for (const name of ${JSON.stringify(names)}) {
    output.env[name] = process.env[name] ?? null;
  }`;
}

describe("flow script executor — the environment allowlist", () => {
  it("keeps the tool server's token, port and secrets out while keeping the shell basics in", async () => {
    withEnv("ARGENT_AUTH_TOKEN", "tool-server-bearer-token");
    withEnv("ARGENT_PORT", "43111");
    withEnv("ARGENT_SECRET_APP_PASSWORD", "hunter2");
    const ws = workspace();
    withEnv("HOME", ws.dir);
    withEnv("USERPROFILE", ws.dir);
    const script = ws.write(
      "env.mjs",
      reporter([
        "ARGENT_AUTH_TOKEN",
        "ARGENT_PORT",
        "ARGENT_SECRET_APP_PASSWORD",
        "PATH",
        "HOME",
        "USERPROFILE",
      ])
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    const env = result.output?.env as Record<string, string | null>;
    expect(env.ARGENT_AUTH_TOKEN).toBeNull();
    expect(env.ARGENT_PORT).toBeNull();
    expect(env.ARGENT_SECRET_APP_PASSWORD).toBeNull();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(ws.dir);
    expect(env.USERPROFILE).toBe(ws.dir);
  });

  it("copies every npm_config_ value, so a project's npm settings survive", async () => {
    withEnv("npm_config_registry", "https://registry.example.com/");
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["npm_config_registry"]));
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect((result.output?.env as Record<string, string>).npm_config_registry).toBe(
      "https://registry.example.com/"
    );
  });

  it.each([
    "npm_config_node_options",
    "npm_config_node-options",
    "npm_config_userconfig",
    "npm_config_globalconfig",
  ])("keeps %s out of the child's environment", async (name) => {
    withEnv(name, "--max-old-space-size=8");
    const ws = workspace();
    const script = ws.write("env.mjs", reporter([name]));
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect((result.output?.env as Record<string, string | null>)[name]).toBeNull();
  });

  it("copies the caller's own environment values on top", async () => {
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["API_URL", "API_KEY"]));
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_URL: "https://api.example.com", API_KEY: "abc" },
    });

    expect(result.output?.env).toEqual({ API_URL: "https://api.example.com", API_KEY: "abc" });
  });

  it.each([
    "NODE_OPTIONS",
    "NODE_CHANNEL_FD",
    "NODE_UNIQUE_ID",
    "npm_config_node_options",
    "NPM_CONFIG_NODE_OPTIONS",
    "npm_config_node-options",
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "ELECTRON_RUN_AS_NODE",
    "ARGENT_FLOW_SCRIPT_RUNNER",
    "ARGENT_OUTPUT",
  ])("refuses %s in a caller-supplied environment", async (name) => {
    const ws = workspace();
    const script = ws.write("env.mjs", `output.ok = true;`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { [name]: "1" },
    });

    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain(name);
  });

  it.each([
    ["a name holding =", "WEIRD=A", 'contains "="'],
    ["an empty name", "", "is empty"],
  ])("refuses %s rather than handing it to the operating system", async (_label, name, said) => {
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["WEIRD"]));
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { [name]: "yes" },
    });

    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain(said);
    expect(result.failure?.message).toContain(JSON.stringify(name));
    expect(result.output).toBeUndefined();
  });

  it.each(["ELECTRON_RUN_AS_NODE", "Electron_Run_As_Node"])(
    "boots the child as Node when the server's environment carries %s",
    async (name) => {
      withEnv(name, "1");
      const ws = workspace();
      const script = ws.write("env.mjs", reporter(["ELECTRON_RUN_AS_NODE"]));
      const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

      expect((result.output?.env as Record<string, string>).ELECTRON_RUN_AS_NODE).toBe("1");
    }
  );

  it("copies an allowlisted name in non-canonical casing on Windows", async () => {
    withEnv("systemroot", "C:\\Windows");
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["systemroot"]));
    const result = await asWindows(() =>
      executor().execute({ scriptPath: script, projectRoot: ws.dir })
    );

    expect((result.output?.env as Record<string, string>).systemroot).toBe("C:\\Windows");
  }, 30_000);

  it("refuses a reserved name in non-canonical casing on Windows", async () => {
    const ws = workspace();
    const script = ws.write("env.mjs", `output.ok = true;`);
    const result = await asWindows(() =>
      executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { Electron_Run_As_Node: "1" },
      })
    );

    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain("Electron_Run_As_Node");
  }, 30_000);

  it("drops the host's spelling of a name a Windows override claims", async () => {
    withEnv("LANG", "en_US.UTF-8");
    const ws = workspace();
    const script = ws.write(
      "lang.mjs",
      `output.lang = Object.entries(process.env)
        .filter(([name]) => name.toLowerCase() === "lang")
        .map(([, value]) => value);`
    );
    const result = await asWindows(() =>
      executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { Lang: "pl_PL.UTF-8" },
      })
    );

    expect(result.output?.lang).toEqual(["pl_PL.UTF-8"]);
  }, 30_000);

  it("does not set the Electron flag when the server's environment lacks it", async () => {
    withoutEnv("ELECTRON_RUN_AS_NODE");
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["ELECTRON_RUN_AS_NODE"]));
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect((result.output?.env as Record<string, string | null>).ELECTRON_RUN_AS_NODE).toBeNull();
  });
});

describe("an env map holding two names that differ only in case", () => {
  it("is a usable map on POSIX, where the two names are two variables", async () => {
    const problem = await asPosix(async () =>
      describeScriptEnvProblem({ API_URL: "first", api_url: "second" })
    );

    expect(problem).toBeNull();
  });

  it("is refused on Windows, in a clause naming both spellings", async () => {
    const problem = await asWindows(async () =>
      describeScriptEnvProblem({ API_URL: "first", api_url: "second" })
    );

    expect(problem).toContain("holds API_URL and api_url, which Windows reads as one variable");
    expect(problem).toContain("Give them one spelling, or names of their own");
  });

  it("merges to one variable per spelling on POSIX", async () => {
    const merged = await asPosix(async () =>
      mergeScriptEnv({ API_URL: "flow" }, { api_url: "step" })
    );

    expect(merged).toEqual({ API_URL: "flow", api_url: "step" });
  });

  it("merges to the later layer's value on Windows, whichever way round the spellings fall", async () => {
    const upperFirst = await asWindows(async () =>
      mergeScriptEnv({ API_URL: "flow" }, { api_url: "step" })
    );
    const lowerFirst = await asWindows(async () =>
      mergeScriptEnv({ api_url: "flow" }, { API_URL: "step" })
    );

    expect(upperFirst).toEqual({ api_url: "step" });
    expect(lowerFirst).toEqual({ API_URL: "step" });
  });
});

describe("flow script executor — execArgv", () => {
  it("sets the heap limit and inherits nothing from the parent's own execArgv", async () => {
    const before = process.execArgv;
    process.execArgv = ["--stack-size=2000"];
    try {
      const ws = workspace();
      const script = ws.write("argv.mjs", `output.execArgv = process.execArgv;`);
      // Explicit because `resolveBounds` falls back to the real
      // `~/.argent/config.json`, which `test/setup/clear-argent-env.ts` cannot
      // strip: on a machine with `scripts.heapLimitMb` set, the inherited value
      // would read as a source regression.
      const result = await executor({ heapLimitMb: 512 }).execute({
        scriptPath: script,
        projectRoot: ws.dir,
      });

      const execArgv = result.output?.execArgv as string[];
      expect(execArgv[0]).toBe("--max-old-space-size=512");
      expect(execArgv[1]).toBe("--import");
      expect(execArgv[2]).toMatch(/^file:\/\/.*flow-script-runner\.mjs$/);
      expect(execArgv).toHaveLength(3);
    } finally {
      process.execArgv = before;
    }
  });
});

describe("flow script executor — the heap limit", () => {
  it("floors a heap limit too small for a Node process to start", async () => {
    const ws = workspace();
    const script = ws.write("argv.mjs", `output.execArgv = process.execArgv;`);
    const result = await executor({ heapLimitMb: 2 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
    });

    expect(result.ok).toBe(true);
    expect(result.output?.execArgv).toContain(`--max-old-space-size=${MIN_SCRIPT_HEAP_LIMIT_MB}`);
  });
});

describe("flow script executor — the host's configured bounds", () => {
  /**
   * A global `~/.argent/config.json` this test alone owns.
   *
   * Both variables, because the global scope resolves from `HOME` on POSIX and
   * `USERPROFILE` on Windows — and pointing them at a fixture is also what
   * keeps the assertion off the configuration of the machine running the suite.
   */
  function configuredHome(ws: ScriptWorkspace, config: Record<string, unknown>): void {
    const home = ws.resolve("home");
    fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".argent", "config.json"), JSON.stringify(config));
    withEnv("HOME", home);
    withEnv("USERPROFILE", home);
  }

  it("bounds a step by the configured scripts.maxTimeoutMs", async () => {
    const ws = workspace();
    configuredHome(ws, { scripts: { maxTimeoutMs: 700 } });
    const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
    const result = await new FlowScriptExecutor({ concurrency: 4 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.failure?.kind).toBe("timeout");
    expect(result.notes.join(" ")).toContain("this host's maximum of 700ms");
    expect(result.durationMs).toBeLessThan(15_000);
  }, 30_000);

  it("ignores a scripts.maxTimeoutMs a step would spend on starting its process", async () => {
    const ws = workspace();
    configuredHome(ws, { scripts: { maxTimeoutMs: 30 } });
    const script = ws.write("slow.mjs", `await new Promise((r) => setTimeout(r, 400));`);
    const result = await new FlowScriptExecutor({ concurrency: 4 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
    });

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).not.toContain("this host's maximum");
  }, 30_000);

  it("gives a script the configured scripts.heapLimitMb", async () => {
    const ws = workspace();
    configuredHome(ws, { scripts: { heapLimitMb: 96 } });
    const script = ws.write("argv.mjs", `output.execArgv = process.execArgv;`);
    const result = await new FlowScriptExecutor({ concurrency: 4 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
    });

    expect(result.output?.execArgv).toContain("--max-old-space-size=96");
  });

  it("reads both bounds again for every step, as the reference page promises", async () => {
    const ws = workspace();
    configuredHome(ws, { scripts: { maxTimeoutMs: 20_000, heapLimitMb: 96 } });
    const script = ws.write("argv.mjs", `output.execArgv = process.execArgv;`);
    const shared = new FlowScriptExecutor({ concurrency: 4 });
    const before = await shared.execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 45_000,
    });
    expect(before.notes.join(" ")).toContain("this host's maximum of 20s");
    expect(before.output?.execArgv).toContain("--max-old-space-size=96");

    configuredHome(ws, { scripts: { maxTimeoutMs: 40_000, heapLimitMb: 128 } });
    const after = await shared.execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 45_000,
    });

    expect(after.notes.join(" ")).toContain("this host's maximum of 40s");
    expect(after.output?.execArgv).toContain("--max-old-space-size=128");
  }, 30_000);
});

describe("flow script executor — the working directory", () => {
  it("runs in project_root when it exists", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
  });

  it("falls back to the flow file's directory when project_root does not exist, and says so", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const missing = path.join(os.tmpdir(), "argent-not-a-real-project-root");
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: missing,
      flowDir: ws.dir,
    });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
    expect(result.notes.join(" ")).toContain(missing);
  });

  it("refuses a relative project_root rather than resolving it against its own cwd", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ".",
      flowDir: ws.dir,
    });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
    expect(result.output?.cwd).not.toBe(process.cwd());
    expect(result.notes.join(" ")).toContain("is not an absolute path");
  });

  it('refuses an absolute project_root carrying a ".." segment', async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: [ws.dir, "..", path.basename(ws.dir)].join(path.sep),
      flowDir: ws.dir,
    });

    expect(result.notes.join(" ")).toContain('contains a ".." segment');
    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
  });

  it("says a project_root that is a file is not a directory", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: script,
      flowDir: ws.dir,
    });

    expect(result.notes.join(" ")).toContain("is not a directory");
  });

  it("refuses the step when no candidate directory exists", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: path.join(os.tmpdir(), "argent-missing-a"),
      flowDir: path.join(os.tmpdir(), "argent-missing-b"),
    });

    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain("No working directory exists");
  });

  // `chmod` is a no-op on Windows and root ignores the mode, so the trigger is
  // only reachable where the mode is enforced.
  const enforcesMode = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!enforcesMode)(
    "reports a working directory the child cannot enter as a verdict, not a hang",
    async () => {
      const ws = workspace();
      const locked = ws.resolve("locked");
      fs.mkdirSync(locked, { recursive: true });
      const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
      fs.chmodSync(locked, 0o000);
      try {
        const started = Date.now();
        const result = await executor().execute({
          scriptPath: script,
          projectRoot: locked,
          timeoutMs: 30_000,
        });

        expect(result.failure?.kind).toBe("spawn");
        expect(result.failure?.message).toContain("Could not start the script process");
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    },
    30_000
  );

  it("refuses a step given no working directory at all", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({ scriptPath: script });

    expect(result.failure?.kind).toBe("invalid");
    expect(result.failure?.message).toContain("No working directory was given");
  });

  it("never inherits the tool server's own working directory", async () => {
    const ws = workspace();
    const script = ws.write("cwd.mjs", `output.cwd = process.cwd();`);
    const result = await executor().execute({ scriptPath: script, flowDir: ws.dir });

    expect(fs.realpathSync(result.output?.cwd as string)).toBe(fs.realpathSync(ws.dir));
    expect(result.output?.cwd).not.toBe(process.cwd());
  });
});

describe("an environment near the operating system's limit", () => {
  const onPosix = it.skipIf(process.platform === "win32");

  onPosix(
    "names the environment's size above the limit and just below it",
    async () => {
      const ws = workspace();
      const script = ws.write("noop.mjs", "output.ok = true;");

      const refused = await executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { BIG: "x".repeat(1_400_000) },
      });
      expect(refused.failure?.kind).toBe("spawn");
      expect(refused.failure?.message).toContain("E2BIG");
      expect(refused.failure?.message).toContain("ARG_MAX");

      const died = await executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { BIG: "x".repeat(1_000_000) },
      });
      const said = `${died.failure?.message ?? ""} ${died.notes.join(" ")}`;
      expect(died.ok).toBe(false);
      expect(said).toMatch(/ARG_MAX/);
      expect(said).toMatch(/100\d{4} bytes/);
    },
    60_000
  );

  onPosix(
    "names the environment's size for a .sh step too",
    async () => {
      const found = await resolveHostBash();
      if (!("path" in found)) return;
      const ws = workspace();
      const script = ws.write("noop.sh", "printf '{}' > \"$ARGENT_OUTPUT\"");

      const refused = await executor().execute({
        scriptPath: script,
        interpreter: "bash",
        projectRoot: ws.dir,
        env: { BIG: "x".repeat(1_400_000) },
      });

      expect(refused.failure?.kind).toBe("spawn");
      expect(refused.failure?.message).toContain("E2BIG");
      expect(refused.failure?.message).toContain("ARG_MAX");
      expect(refused.failure?.message).not.toContain("scripts.bash");
      expect(refused.failure?.message).not.toContain("is not a bash");
    },
    60_000
  );

  it("says nothing about the environment when an ordinary one dies early", async () => {
    const ws = workspace();
    const script = ws.write("early.mjs", "process.exit(7);");
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { SMALL: "value" },
    });

    expect(result.ok).toBe(false);
    expect(result.notes.join(" ")).not.toContain("ARG_MAX");
  }, 30_000);

  it("stays off a step that was cancelled before the runner started", async () => {
    const ws = workspace();
    const script = ws.write("slow.mjs", "await new Promise((r) => setTimeout(r, 5000));");
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { BIG: "x".repeat(400 * 1024) },
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("cancelled");
    expect(result.notes.join(" ")).not.toContain("ARG_MAX");
  }, 30_000);
});
