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

/**
 * The other side of each rule `asWindows` covers. Forced rather than left to
 * the host, because this file also runs on the Windows E2E job: a case-sensitive
 * expectation left to the real platform would assert the wrong branch there.
 */
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
    // Both home variables are planted rather than read off the host. Read off
    // it, the home assertion was `env.HOME` against `process.env.HOME ?? null`,
    // which on Windows compares null to null and asserts nothing about the
    // allowlist on the very platform this file was enabled for. USERPROFILE is
    // the spelling Windows carries the home directory under, and is on the list
    // beside HOME, so planting both keeps a live assertion on either host.
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

  // npm defines `node-options` as a real config key and hands it back as
  // NODE_OPTIONS to what it starts, so the `npm_config_` prefix would carry
  // through exactly what the exact name is reserved to keep out. `userconfig`
  // and `globalconfig` reach the same key through an `.npmrc` they name, and
  // npm takes `_` and `-` in a key as the same character.
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

  // Spelled out rather than imported: the constant is private, and a literal
  // catches a rename of the name the runner preload actually reads.
  it.each([
    "NODE_OPTIONS",
    "NODE_CHANNEL_FD",
    "NODE_UNIQUE_ID",
    "npm_config_node_options",
    // npm reads its config names without regard to case wherever it runs, and
    // takes `_` and `-` in a key as the same character, so these spellings are
    // refused on POSIX too, where the others are exact.
    "NPM_CONFIG_NODE_OPTIONS",
    "npm_config_node-options",
    // Both name an `.npmrc` npm would read `node-options` from.
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "ELECTRON_RUN_AS_NODE",
    "ARGENT_FLOW_SCRIPT_RUNNER",
    // The bash exchange. Refused whichever language the step runs, because a
    // flow-level map applies to every step and the name would steer the
    // runner's own protocol.
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

  // The operating system carries an environment as `NAME=value` strings, so
  // neither of these can survive the trip: the first moves the split and hands
  // the script `WEIRD="A=yes"`, an environment the flow never asked for, while
  // the step passes; the second leaves an entry with no name in front of it.
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
      // An Electron-hosted tool server makes `process.execPath` the Electron
      // binary, and only this flag keeps a forked child in Node mode. The read
      // is case-insensitive because a Windows host may surface non-canonical
      // casing.
      withEnv(name, "1");
      const ws = workspace();
      const script = ws.write("env.mjs", reporter(["ELECTRON_RUN_AS_NODE"]));
      const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

      expect((result.output?.env as Record<string, string>).ELECTRON_RUN_AS_NODE).toBe("1");
    }
  );

  it("copies an allowlisted name in non-canonical casing on Windows", async () => {
    // Windows environment names are case-insensitive, so a host may surface
    // any of them under a casing the list does not spell. `SystemRoot` is the
    // one a script that makes any network call fails without.
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
    // On Windows the override and the host's own name are one variable, so
    // handing both to the fork left Node to dedupe them and keep whichever
    // sorted first: the host's value could be the one the script read, in place
    // of the flow's. LANG is on the allowlist, so without this branch the host
    // entry survives beside the override.
    //
    // Counted by folding case rather than read under one spelling, because a
    // real Windows child answers to either spelling while a POSIX child answers
    // only to the one it was handed - the count is the part that means the same
    // thing on both.
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
    // A developer running the suite from an Electron-hosted shell has the flag
    // exported already.
    withoutEnv("ELECTRON_RUN_AS_NODE");
    const ws = workspace();
    const script = ws.write("env.mjs", reporter(["ELECTRON_RUN_AS_NODE"]));
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect((result.output?.env as Record<string, string | null>).ELECTRON_RUN_AS_NODE).toBeNull();
  });
});

describe("an env map holding two names that differ only in case", () => {
  // Reached through `parseFlow` or a tool everywhere else in the suite, and
  // neither channel can put the pair in front of these two functions on a host
  // whose platform decides the answer. Called directly here so both sides of
  // each rule are asserted wherever the suite runs.

  it("is a usable map on POSIX, where the two names are two variables", async () => {
    // The refusal below is a platform rule, not a rule about the map: a flow
    // authored on macOS that argent began refusing everywhere would break files
    // that were never wrong on the host they run on.
    const problem = await asPosix(async () =>
      describeScriptEnvProblem({ API_URL: "first", api_url: "second" })
    );

    expect(problem).toBeNull();
  });

  it("is refused on Windows, in a clause naming both spellings", async () => {
    // Windows carries one variable per name however it is spelled, and the two
    // entries are one layer, so there is no precedence between them to appeal
    // to: whichever was written last would take the other's place with nothing
    // said. The author is reading a map where nothing marks the pair as a pair,
    // so the clause has to name both spellings to be actionable.
    const problem = await asWindows(async () =>
      describeScriptEnvProblem({ API_URL: "first", api_url: "second" })
    );

    expect(problem).toContain("holds API_URL and api_url, which Windows reads as one variable");
    expect(problem).toContain("Give them one spelling, or names of their own");
  });

  it("merges to one variable per spelling on POSIX", async () => {
    // Two variables on a case-sensitive host, so folding them here would drop a
    // value the script asked for and that nothing refused on the way in.
    const merged = await asPosix(async () =>
      mergeScriptEnv({ API_URL: "flow" }, { api_url: "step" })
    );

    expect(merged).toEqual({ API_URL: "flow", api_url: "step" });
  });

  it("merges to the later layer's value on Windows, whichever way round the spellings fall", async () => {
    // Two layers spelling one variable differently are two layers setting the
    // same thing, so the documented precedence has to decide here. Keeping both
    // left the child environment to dedupe them, and Node keeps whichever sorts
    // first - which is why the first pair is the one that tells the two rules
    // apart: "API_URL" sorts before "api_url", so precedence answers "step"
    // while ASCII order answers "flow".
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
    // Below about 5 MiB the child dies inside V8's own startup, before the
    // runner can send anything, with a failure naming neither the bound nor the
    // value behind it.
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
    // Refused by the schema, so the key reads as unset and the default stands.
    // Honoured, this would cap every step at 30ms — including one that asks
    // for nothing — and error a script by how busy the machine was.
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
    // One executor across both steps: the tool server shares a single instance
    // for the life of the process, so a value held from the first step would
    // outlive every later edit of the file.
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
      // Joined by hand: `path.join` would normalise the segment away.
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
      // The directory passes every check the executor can make, so the failure
      // lands in the fork itself, which reports it asynchronously through an
      // `error` event rather than a throw — a step missing that listener would
      // wait out its whole time limit instead of answering.
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
  // `ARG_MAX` bounds the block of arguments and environment a new process is
  // handed. Above it the fork is refused outright; just below it the fork
  // succeeds and Node dies inside its own startup, which arrives as a runner
  // that exited before the script started — a verdict naming an exit code and
  // nothing else. A flow could not set `env` at all before this branch, so
  // both bands are newly reachable and neither had a test.
  it("names the environment's size above the limit and just below it", async () => {
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
    // Whichever side of the line this host puts a megabyte on, the size is
    // named: the refusal names it in the message, the early exit in a note.
    const said = `${died.failure?.message ?? ""} ${died.notes.join(" ")}`;
    expect(died.ok).toBe(false);
    expect(said).toMatch(/ARG_MAX/);
    expect(said).toMatch(/100\d{4} bytes/);
  }, 60_000);

  it("names the environment's size for a .sh step too", async () => {
    // A `.sh` step touches the child environment EARLIER than a `.mjs` one: the
    // bash-version probe spawns each candidate, and that spawn is the one the
    // operating system refuses. Every candidate then failed the probe, and the
    // step's reason condemned the host's bash installation and pointed the
    // author at `scripts.bash` — a different subsystem, and one that is
    // working. The case above covers `.mjs`, which reaches the fork.
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
  }, 60_000);

  it("says nothing about the environment when an ordinary one dies early", async () => {
    const ws = workspace();
    // The runner sends `started` from its preload, BEFORE the entry script
    // loads, so this exits after the handshake and earns an `exit` verdict
    // rather than the protocol one the note is for. It pins the shape; the case
    // below is what makes the size term load-bearing.
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
    // A cancellation lands before `started` does — the preload is fast but not
    // instant — and the verdict is `cancelled`, which the note does not explain.
    // The condition consulted only `!startedSeen`, so a large environment was
    // named as the likely cause of an abort the caller raised itself. Unlike a
    // timeout, cancellation has no floor, so an abort that arrives with the
    // request reaches this every time.
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
