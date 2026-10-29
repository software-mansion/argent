import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyMcpEntry, type EntryContext } from "../src/doctor-entries.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    scope: "project",
    projectRoot,
    cwd: projectRoot,
    globalOnPath: true,
    localInstalled: false,
    argentCmd: "argent",
    installCmd: "pnpm install",
    ...overrides,
  };
}

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("classifyMcpEntry", () => {
  it("accepts bare `argent mcp` when argent is on PATH", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["mcp"] }, ctx()).status).toBe("ok");
  });

  it("fails bare `argent mcp` when argent is not on PATH", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
    expect(result.fix).toContain("argent init");
  });

  it("only warns when a version manager's env may make `argent` resolve inside the editor", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { MISE_NODE_VERSION: "24.14.1" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("warn");
  });

  it("does not let env that can't change the lookup soften a dead entry", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { ARGENT_IOS_TEAM_ID: "ABCDE12345" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
  });

  it("looks the command up on the PATH the entry sets, not this shell's", () => {
    const bin = path.join(projectRoot, "bin");
    const entry = { command: "argent", args: ["mcp"], env: { PATH: bin } };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "argent"), "", { mode: 0o755 });
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("looks node and npx up on the PATH the entry sets", () => {
    const bin = path.join(projectRoot, "bin");
    const script = path.join(projectRoot, "cli.js");
    fs.writeFileSync(script, "");
    const npx = {
      command: "npx",
      args: ["-y", "@swmansion/argent@latest", "mcp"],
      env: { PATH: bin },
    };
    const node = { command: "node", args: [script, "mcp"], env: { PATH: bin } };
    expect(classifyMcpEntry(npx, ctx())).toMatchObject({
      status: "error",
      label: expect.stringContaining("`npx` is not on the PATH this entry sets"),
    });
    expect(classifyMcpEntry(node, ctx()).status).toBe("error");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npx"), "", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "node"), "", { mode: 0o755 });
    expect(classifyMcpEntry(npx, ctx()).status).toBe("ok");
    expect(classifyMcpEntry(node, ctx()).status).toBe("ok");
  });

  it("does not count the legacy ARGENT_MCP_LOG env as a customization", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"], env: { ARGENT_MCP_LOG: "/tmp/x.log" } },
      ctx({ globalOnPath: false })
    );
    expect(result.status).toBe("error");
  });

  it("checks a local-mode `node <path>` entry against the project root", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");

    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("requires a local install for npx and yarn entries", () => {
    for (const entry of [
      { command: "npx", args: ["--no-install", "argent", "mcp"] },
      { command: "yarn", args: ["argent", "mcp"] },
    ]) {
      const missing = classifyMcpEntry(entry, ctx({ globalOnPath: false }));
      expect(missing).toMatchObject({ status: "error", fix: "pnpm install" });
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("ok");
    }
  });

  it("accepts an on-demand npx entry without a local install", () => {
    const entry = { command: "npx", args: ["-y", "@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("warns when the project's devEngines makes npm refuse every npx", () => {
    const devEngines = (runtime: unknown) =>
      fs.writeFileSync(
        path.join(projectRoot, "package.json"),
        JSON.stringify({ devEngines: { runtime } })
      );
    const onDemand = { command: "npx", args: ["-y", "@swmansion/argent@latest", "mcp"] };
    const local = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    devEngines({ name: "node", version: "18.x", onFail: "error" });
    expect(classifyMcpEntry(onDemand, ctx())).toMatchObject({
      status: "warn",
      label: expect.stringMatching(/devEngines wants Node 18\.x/),
      fix: expect.stringMatching(/onFail to "warn"/),
    });
    expect(classifyMcpEntry(local, ctx({ localInstalled: true })).status).toBe("warn");
    devEngines({ name: "node", version: "18.x" });
    expect(classifyMcpEntry(onDemand, ctx()).status).toBe("warn");
    devEngines({ name: "node", version: "18.x", onFail: "warn" });
    expect(classifyMcpEntry(onDemand, ctx()).status).toBe("ok");
    devEngines([
      { name: "node", version: "18.x" },
      { name: "node", version: process.version },
    ]);
    expect(classifyMcpEntry(onDemand, ctx()).status).toBe("ok");
    devEngines({ name: "bun", version: "1.x" });
    expect(classifyMcpEntry(onDemand, ctx()).status).toBe("ok");
  });

  it("accepts the other on-demand spellings", () => {
    for (const args of [
      ["-y", "argent@latest", "mcp"],
      ["argent", "mcp"],
      ["-y", "--package=@swmansion/argent", "argent", "mcp"],
    ]) {
      expect(classifyMcpEntry({ command: "npx", args }, ctx()).status).toBe("ok");
    }
    const dlx = { command: "yarn", args: ["dlx", "@swmansion/argent", "mcp"] };
    expect(classifyMcpEntry(dlx, ctx({ yarnBerry: true })).status).toBe("ok");
  });

  it("doesn't vouch for `yarn dlx` outside a Yarn 2+ project", () => {
    const dlx = { command: "yarn", args: ["dlx", "@swmansion/argent", "mcp"] };
    const result = classifyMcpEntry(dlx, ctx({ globalOnPath: false }));
    expect(result.status).toBe("info");
    expect(result.label).toMatch(/Yarn 2 or later/);
  });

  it("lets `npx --no-install argent` fall back to npm's global argent, not PATH's", () => {
    const entry = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    expect(classifyMcpEntry(entry, ctx({ npmGlobalHasArgent: true })).status).toBe("ok");
    expect(
      classifyMcpEntry(entry, ctx({ globalOnPath: false, npmGlobalHasArgent: true })).status
    ).toBe("ok");
    expect(
      classifyMcpEntry(entry, ctx({ globalOnPath: true, npmGlobalHasArgent: false })).status
    ).toBe("error");
  });

  it("asks to declare the dependency when package.json doesn't list argent", () => {
    const entry = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    const noArgent = { globalOnPath: false, npmGlobalHasArgent: false };
    expect(classifyMcpEntry(entry, ctx({ ...noArgent, localDeclared: true })).fix).toBe(
      "pnpm install"
    );
    expect(classifyMcpEntry(entry, ctx({ ...noArgent, localDeclared: false })).fix).toBe(
      "Add @swmansion/argent to devDependencies, then pnpm install"
    );
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    const node = {
      command: "node",
      args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"],
    };
    expect(classifyMcpEntry(node, ctx({ localDeclared: false })).fix).toBe(
      "Add @swmansion/argent to devDependencies, then pnpm install"
    );
  });

  it("resolves an npx entry the way npx does, through ancestors", () => {
    const entry = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    const noGlobal = { globalOnPath: false };
    expect(classifyMcpEntry(entry, ctx({ ...noGlobal, localResolvable: true })).status).toBe("ok");
    expect(classifyMcpEntry(entry, ctx({ ...noGlobal, localResolvable: false })).status).toBe(
      "error"
    );
  });

  it("finds the script after node options that take a value", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    for (const flags of [
      ["-r", "dotenv/config"],
      ["--env-file", ".env"],
      ["--import", "tsx"],
    ]) {
      expect(
        classifyMcpEntry({ command: "node", args: [...flags, rel, "mcp"] }, ctx()).status
      ).toBe("ok");
    }
  });

  it("resolves a relative script against the entry's own cwd", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const app = path.join(projectRoot, "apps", "mobile");
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), "");
    const entry = { command: "node", args: [rel, "mcp"], cwd: "${workspaceFolder}/apps/mobile" };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
    expect(classifyMcpEntry({ ...entry, cwd: "${env:APP}" }, ctx()).status).toBe("info");
  });

  it("applies an entry's cwd only the way its editor does", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const app = path.join(projectRoot, "apps", "mobile");
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), "");
    const entry = { command: "node", args: [rel, "mcp"], cwd: "apps/mobile" };
    const status = (cwdSupport: EntryContext["cwdSupport"], cwd = entry.cwd) =>
      classifyMcpEntry({ ...entry, cwd }, ctx({ cwdSupport })).status;
    expect(status("ignored")).toBe("error");
    expect(status("literal")).toBe("ok");
    expect(status("literal", "${workspaceFolder}/apps/mobile")).toBe("info");
    expect(status("absolute-only")).toBe("info");
    expect(status("absolute-only", app)).toBe("ok");
  });

  it("fails an entry whose cwd does not exist", () => {
    const entry = { command: "argent", args: ["mcp"], cwd: "/nonexistent-dir" };
    expect(classifyMcpEntry(entry, ctx({ cwdSupport: "literal" }))).toMatchObject({
      status: "error",
      label: expect.stringContaining("cwd /nonexistent-dir does not exist"),
    });
    expect(classifyMcpEntry(entry, ctx({ cwdSupport: "ignored" })).status).toBe("ok");
  });

  it("does not judge a command that uses a variable this shell can't fill in", () => {
    const entry = { command: "${ARGENT_TEST_UNSET_DIR}/argent", args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("info");
  });

  it("doesn't count a package that only contains the argent name as on-demand", () => {
    const entry = { command: "npx", args: ["-y", "-p", "@swmansion/argent-fork", "argent", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("fails entries that don't end in `mcp`", () => {
    for (const entry of [
      { command: "argent", args: [] },
      { command: "argent", args: ["server", "start"] },
      { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js"] },
      { command: "npx", args: ["--no-install", "argent"] },
    ]) {
      expect(classifyMcpEntry(entry, ctx({ localInstalled: true })).status).toBe("error");
    }
  });

  it("warns about an entry switched off in the editor", () => {
    const entry = { command: "argent", args: ["mcp"], switchedOffBy: ["disabled" as const] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("warn");
  });

  it("skips node flags to find the script", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    const entry = { command: "node", args: ["--no-warnings", rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("does not judge a path that uses an editor variable", () => {
    const entry = {
      command: "node",
      args: ["${workspaceFolder}/node_modules/@swmansion/argent/dist/cli.js", "mcp"],
    };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("info");
  });

  it("checks that an absolute command exists", () => {
    const missing = { command: path.join(projectRoot, "bin", "argent"), args: ["mcp"] };
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("error");

    fs.mkdirSync(path.join(projectRoot, "bin"));
    fs.writeFileSync(missing.command, "");
    expect(classifyMcpEntry(missing, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("points a dead project-dependency path at the project's install command", () => {
    const entry = { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).fix).toMatch(/^Point the entry/);
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    expect(classifyMcpEntry(entry, ctx()).fix).toBe("pnpm install");
  });

  it("flags an unparseable entry", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).status).toBe("warn");
  });

  it("does not judge a custom command", () => {
    expect(classifyMcpEntry({ command: "argent-dev", args: [] }, ctx()).status).toBe("info");
  });
});

describe("classifyMcpEntry with a failing shim", () => {
  const shimBin = () => {
    const bin = path.join(projectRoot, "shims", "argent");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "");
    return bin;
  };
  const failing = (bin: string) =>
    ctx({ globalOnPath: false, globalRunError: "mise ERROR No version is set", globalBin: bin });

  it("fails a bare `argent mcp` entry", () => {
    expect(
      classifyMcpEntry({ command: "argent", args: ["mcp"] }, failing(shimBin()))
    ).toMatchObject({ status: "error", detail: "mise ERROR No version is set" });
  });

  it("fails an entry that names the same shim by its path", () => {
    const bin = shimBin();
    expect(classifyMcpEntry({ command: bin, args: ["mcp"] }, failing(bin)).status).toBe("error");
  });

  it("passes an entry that names another argent by its path", () => {
    const other = path.join(projectRoot, "argent");
    fs.writeFileSync(other, "");
    expect(classifyMcpEntry({ command: other, args: ["mcp"] }, failing(shimBin())).status).toBe(
      "ok"
    );
  });

  it("only warns when the entry's own env may make the shim work", () => {
    const entry = { command: "argent", args: ["mcp"], env: { MISE_NODE_VERSION: "24.14.1" } };
    expect(classifyMcpEntry(entry, failing(shimBin())).status).toBe("warn");
  });
});

describe("classifyMcpEntry argument rules", () => {
  it("accepts arguments after a node entry's `mcp`, and nothing between script and `mcp`", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry({ command: "node", args: [rel, "mcp", "--x"] }, ctx()).status).toBe(
      "ok"
    );
    expect(classifyMcpEntry({ command: "node", args: [rel, "x", "mcp"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("needs `mcp` right after the package in an npx entry", () => {
    const entry = { command: "npx", args: ["-y", "@swmansion/argent", "foo", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("accepts arguments after `mcp`, which the CLI ignores", () => {
    expect(classifyMcpEntry({ command: "argent", args: ["mcp", "--stdio"] }, ctx()).status).toBe(
      "ok"
    );
    expect(classifyMcpEntry({ command: "argent", args: ["--x", "mcp"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("fails a node entry whose existing script is not followed by `mcp`", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    expect(classifyMcpEntry({ command: "node", args: [rel] }, ctx()).status).toBe("error");
    expect(classifyMcpEntry({ command: "node", args: [rel, "server"] }, ctx()).status).toBe(
      "error"
    );
  });

  it("resolves a project entry's script against the project root, a global one against cwd", () => {
    const rel = "node_modules/@swmansion/argent/dist/cli.js";
    const cwd = path.join(projectRoot, "src");
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), "");
    fs.mkdirSync(cwd);
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(classifyMcpEntry(entry, ctx({ cwd })).status).toBe("ok");
    expect(classifyMcpEntry(entry, ctx({ cwd, scope: "global" })).status).toBe("error");
  });

  it("does not treat `npx --no-install @swmansion/argent` as fetched on demand", () => {
    for (const flag of ["--no-install", "--no"]) {
      const entry = { command: "npx", args: [flag, "@swmansion/argent", "mcp"] };
      expect(classifyMcpEntry(entry, ctx({ npmGlobalHasArgent: false })).status).toBe("error");
    }
  });

  it("lets `npx --no-install @swmansion/argent` fall back to npm's global argent", () => {
    const entry = { command: "npx", args: ["--no-install", "@swmansion/argent", "mcp"] };
    expect(classifyMcpEntry(entry, ctx({ npmGlobalHasArgent: true })).status).toBe("ok");
  });

  it("does not treat a yarn entry as fetched on demand", () => {
    const entry = { command: "yarn", args: ["@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("resolves a relative command path instead of looking `argent` up on PATH", () => {
    const entry = { command: "./node_modules/.bin/argent", args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: true })).status).toBe("error");
    fs.mkdirSync(path.join(projectRoot, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "node_modules", ".bin", "argent"), "");
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("ok");
  });

  it("treats `argent.cmd` as argent only on Windows", () => {
    const entry = { command: "argent.cmd", args: ["mcp"] };
    withPlatform("linux", () => expect(classifyMcpEntry(entry, ctx()).status).toBe("info"));
    withPlatform("win32", () => expect(classifyMcpEntry(entry, ctx()).status).toBe("ok"));
  });

  it("checks the script of a `node.exe` entry on Windows", () => {
    const entry = { command: "node.exe", args: ["missing/dist/cli.js", "mcp"] };
    withPlatform("win32", () =>
      expect(classifyMcpEntry(entry, ctx())).toMatchObject({
        status: "error",
        label: expect.stringMatching(/does not exist/),
      })
    );
  });

  it("prints the full bin dir in the PATH fix on Windows", () => {
    const bin = path.join(os.homedir(), "AppData", "Roaming", "npm");
    const entry = { command: "argent", args: ["mcp"] };
    withPlatform("win32", () =>
      expect(classifyMcpEntry(entry, ctx({ globalOnPath: false, offPathGlobalBin: bin })).fix).toBe(
        `Add ${bin} to PATH`
      )
    );
  });

  it("points a broken Claude Code local-scope entry at claude mcp remove", () => {
    const result = classifyMcpEntry({ command: "argent", args: [] }, ctx({ claudeLocal: true }));
    expect(result.fix).toMatch(/claude mcp remove -s local argent/);
  });

  it("only warns about a dead entry the editor has switched off, keeping its fix", () => {
    const entry = { command: "argent", args: ["mcp"], switchedOffBy: ["enabled" as const] };
    const result = classifyMcpEntry(entry, ctx({ globalOnPath: false }));
    expect(result.status).toBe("warn");
    expect(result.label).toMatch(/can't start \(switched off in the editor\)/);
    expect(result.fix).toContain("npm i -g @swmansion/argent");
  });

  it("asks to turn a switched-off entry back on before init, which skips it", () => {
    const entry = { command: "argent", args: ["serve"], switchedOffBy: ["disabled" as const] };
    const result = classifyMcpEntry(entry, ctx());
    expect(result.status).toBe("warn");
    expect(result.fix).toMatch(
      /^Turn the argent server back on in the editor's MCP settings, then: /
    );
    expect(result.fix).toMatch(/init$/);
  });

  it("names the off-PATH bin dir of a global install", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false, offPathGlobalBin: "/opt/npm-global/bin" })
    );
    expect(result.fix).toBe("Add /opt/npm-global/bin to PATH");
  });
});

const writeFile = (file: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { mode });
  return file;
};

describe("classifyMcpEntry the way each editor starts it", () => {
  const rel = "node_modules/@swmansion/argent/dist/cli.js";

  afterEach(() => vi.unstubAllEnvs());

  it("does not judge a remote entry, and hides its credentials", () => {
    const entry = { command: "", args: [], url: "http://user:secret@127.0.0.1:9/mcp" };
    const result = classifyMcpEntry(entry, ctx({ globalOnPath: false }));
    expect(result.status).toBe("info");
    expect(result.label).toMatch(/remote MCP server, not verified/);
    expect(result.label).not.toMatch(/secret/);
    const off = { ...entry, switchedOffBy: ["disabled" as const] };
    expect(classifyMcpEntry(off, ctx()).status).toBe("warn");
  });

  it("runs a relative script from where the editor starts, warning when only the root has it", () => {
    writeFile(path.join(projectRoot, rel));
    const sub = path.join(projectRoot, "sub");
    fs.mkdirSync(sub);
    const entry = { command: "node", args: [rel, "mcp"] };
    expect(
      classifyMcpEntry(entry, ctx({ cwd: sub, spawnDir: sub, spawnsInLaunchDir: true }))
    ).toMatchObject({
      status: "warn",
      label: expect.stringMatching(/resolves only when the editor starts in the project root/),
    });
    const fromRoot = ctx({ spawnDir: projectRoot, spawnsInLaunchDir: true });
    expect(classifyMcpEntry(entry, fromRoot).status).toBe("ok");
    expect(classifyMcpEntry(entry, ctx({ spawnDir: sub })).status).toBe("error");
  });

  it("expands ${VAR}, ${env:VAR} and {env:VAR}, and leaves a bare $VAR unverified", () => {
    const bin = writeFile(path.join(projectRoot, "gbin", "argent"), 0o755);
    vi.stubEnv("ARGENT_TEST_DIR", path.dirname(bin));
    for (const command of [
      "${ARGENT_TEST_DIR}/argent",
      "${env:ARGENT_TEST_DIR}/argent",
      "{env:ARGENT_TEST_DIR}/argent",
    ]) {
      expect(classifyMcpEntry({ command, args: ["mcp"] }, ctx()).status, command).toBe("ok");
    }
    const missing = { command: "${ARGENT_TEST_DIR}/nope/argent", args: ["mcp"] };
    expect(classifyMcpEntry(missing, ctx()).status).toBe("error");
    const bare = { command: "$ARGENT_TEST_DIR/argent", args: ["mcp"] };
    expect(classifyMcpEntry(bare, ctx()).status).toBe("info");
  });

  it("expands a leading ~ only for editors that do", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-home-"));
    try {
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      writeFile(path.join(home, "bin", "argent"), 0o755);
      const entry = { command: "~/bin/argent", args: ["mcp"] };
      expect(classifyMcpEntry(entry, ctx({ expandsTilde: true })).status).toBe("ok");
      expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("ignores a `Path` env key off Windows", () => {
    const entry = { command: "argent", args: ["mcp"], env: { Path: "C:\\Users\\me\\npm" } };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("expands variables in the entry's PATH, and leaves ones it can't fill in unverified", () => {
    const bin = writeFile(path.join(projectRoot, "gbin", "argent"), 0o755);
    vi.stubEnv("ARGENT_TEST_DIR", path.dirname(bin));
    const withPath = (PATH: string) => ({ command: "argent", args: ["mcp"], env: { PATH } });
    const noGlobal = ctx({ globalOnPath: false });
    expect(classifyMcpEntry(withPath("${ARGENT_TEST_DIR}"), noGlobal).status).toBe("ok");
    expect(classifyMcpEntry(withPath("${ARGENT_TEST_DIR}/nothere"), ctx()).status).toBe("error");
    expect(classifyMcpEntry(withPath("$HOME/bin"), ctx()).status).toBe("info");
  });

  it("appends the entry's PATH to the editor's own for VS Code", () => {
    const entry = { command: "argent", args: ["mcp"], env: { PATH: "/opt/homebrew/bin" } };
    expect(classifyMcpEntry(entry, ctx({ appendsPath: true })).status).toBe("ok");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    const bin = writeFile(path.join(projectRoot, "extra", "argent"), 0o755);
    const added = { ...entry, env: { PATH: path.dirname(bin) } };
    expect(classifyMcpEntry(added, ctx({ appendsPath: true, globalOnPath: false })).status).toBe(
      "ok"
    );
  });

  it("fails an entry whose PATH finds the failing shim", () => {
    const bin = writeFile(path.join(projectRoot, "shims", "argent"), 0o755);
    const entry = { command: "argent", args: ["mcp"], env: { PATH: path.dirname(bin) } };
    const failing = ctx({ globalOnPath: false, globalRunError: "mise ERROR", globalBin: bin });
    expect(classifyMcpEntry(entry, failing)).toMatchObject({
      status: "error",
      detail: "mise ERROR",
      fix: expect.stringMatching(/npm i -g @swmansion\/argent/),
    });
    const pinned = { ...entry, env: { ...entry.env, MISE_NODE_VERSION: "24" } };
    expect(classifyMcpEntry(pinned, failing).status).toBe("warn");
  });

  it("judges the command a Windows `cmd /c` wrapper runs", () => {
    const wrapped = { command: "cmd", args: ["/c", "argent", "mcp"] };
    expect(classifyMcpEntry(wrapped, ctx({ globalOnPath: false }))).toMatchObject({
      status: "error",
      label: expect.stringMatching(/^cmd \/c argent mcp — `argent` is not on PATH/),
    });
    expect(classifyMcpEntry(wrapped, ctx()).status).toBe("ok");
    const init = { command: "cmd.exe", args: ["/C", "argent", "init"] };
    expect(classifyMcpEntry(init, ctx()).status).toBe("error");
  });

  it("does not print a token passed as an argument", () => {
    const entry = {
      command: "env",
      args: [
        "ARGENT_AUTH_TOKEN=SECRETARGTOKEN",
        "ARGENT_TOOLS_URL=http://10.0.0.5:1",
        "argent",
        "mcp",
      ],
    };
    const { label } = classifyMcpEntry(entry, ctx());
    expect(label).not.toMatch(/SECRETARGTOKEN/);
    expect(label).toMatch(/ARGENT_AUTH_TOKEN=\*\*\* ARGENT_TOOLS_URL=http:\/\/10\.0\.0\.5:1/);
  });
});

describe("classifyMcpEntry details", () => {
  it("skips the value of every node option that takes one", () => {
    const script = writeFile(path.join(projectRoot, "x", "cli.js"));
    for (const option of [
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
    ]) {
      const entry = { command: "node", args: [option, "value", script, "mcp"] };
      expect(classifyMcpEntry(entry, ctx()).status, option).toBe("ok");
    }
  });

  it("passes an absolute entry naming a healthy global argent", () => {
    const bin = writeFile(path.join(projectRoot, "bin", "argent"));
    const entry = { command: bin, args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx({ globalBin: bin })).status).toBe("ok");
  });

  it("matches a relative path naming the failing shim", () => {
    const bin = writeFile(path.join(projectRoot, "bin", "argent"));
    const failing = ctx({ globalOnPath: false, globalRunError: "mise ERROR", globalBin: bin });
    expect(classifyMcpEntry({ command: "./bin/argent", args: ["mcp"] }, failing)).toMatchObject({
      status: "error",
      detail: "mise ERROR",
      fix: expect.stringMatching(/npm i -g/),
    });
  });

  it("points a dead Claude Code local-scope path at claude mcp remove", () => {
    const entry = { command: "/opt/gone/argent", args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx({ claudeLocal: true })).fix).toMatch(
      /claude mcp remove -s local argent, then argent init/
    );
  });

  it("resolves the entry's cwd against the project, and ${workspaceFolder} to its root", () => {
    writeFile(path.join(projectRoot, "apps", "mobile", "dist", "cli.js"));
    writeFile(path.join(projectRoot, "tools", "x.js"));
    const sub = path.join(projectRoot, "sub");
    fs.mkdirSync(sub);
    const app = { command: "node", args: ["dist/cli.js", "mcp"], cwd: "apps/mobile" };
    expect(classifyMcpEntry(app, ctx()).status).toBe("ok");
    const tools = { command: "node", args: ["tools/x.js", "mcp"], cwd: "${workspaceFolder}" };
    expect(classifyMcpEntry(tools, ctx({ cwd: sub })).status).toBe("ok");
  });

  it("offers the install command only for a missing relative node_modules script", () => {
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
    const build = classifyMcpEntry({ command: "node", args: ["build/cli.js", "mcp"] }, ctx());
    expect(build.fix).toMatch(/^Point the entry/);
    const deps = classifyMcpEntry(
      { command: "node", args: ["node_modules/@swmansion/argent/dist/cli.js", "mcp"] },
      ctx()
    );
    expect(deps).toMatchObject({ status: "error", fix: "pnpm install" });
  });

  it("anchors the package and env name patterns", () => {
    const createArgent = { command: "npx", args: ["-y", "create-argent", "mcp"] };
    expect(classifyMcpEntry(createArgent, ctx()).status).toBe("error");
    const nodePath = { command: "argent", args: ["mcp"], env: { NODE_PATH: "/x" } };
    expect(classifyMcpEntry(nodePath, ctx({ globalOnPath: false })).status).toBe("error");
  });

  it("reads both --package spellings", () => {
    for (const args of [
      ["-y", "--package=other-tool", "argent", "mcp"],
      ["-y", "--package", "other-tool", "argent", "mcp"],
    ]) {
      expect(classifyMcpEntry({ command: "npx", args }, ctx()).status).toBe("error");
    }
  });

  it("gives a fix for an unparsed entry, a switched-off one and a PATH without argent", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).fix).toBe("argent init");
    const off = { command: "argent", args: ["mcp"], switchedOffBy: ["enabled" as const] };
    expect(classifyMcpEntry(off, ctx())).toMatchObject({
      detail: "`enabled: false`",
      fix: expect.stringMatching(/Turn the argent server back on/),
    });
    const noArgent = { command: "argent", args: ["mcp"], env: { PATH: "/nonexistent" } };
    expect(classifyMcpEntry(noArgent, ctx()).fix).toMatch(/Add argent's bin dir/);
  });
});
