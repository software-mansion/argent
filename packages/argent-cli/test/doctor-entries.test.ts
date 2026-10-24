import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("accepts the other on-demand spellings", () => {
    for (const args of [
      ["-y", "argent@latest", "mcp"],
      ["argent", "mcp"],
      ["-y", "--package=@swmansion/argent", "argent", "mcp"],
    ]) {
      expect(classifyMcpEntry({ command: "npx", args }, ctx()).status).toBe("ok");
    }
    const dlx = { command: "yarn", args: ["dlx", "@swmansion/argent", "mcp"] };
    expect(classifyMcpEntry(dlx, ctx()).status).toBe("ok");
  });

  it("lets `npx --no-install argent` fall back to the global argent", () => {
    const entry = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
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

  it("does not judge a command that uses an editor variable", () => {
    const entry = { command: "${HOME}/.local/bin/argent", args: ["mcp"] };
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
      expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
    }
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

  it("points a broken Claude Code local-scope entry at claude mcp remove", () => {
    const result = classifyMcpEntry({ command: "argent", args: [] }, ctx({ claudeLocal: true }));
    expect(result.fix).toMatch(/claude mcp remove -s local argent/);
  });

  it("still fails a dead entry that is switched off", () => {
    const entry = { command: "argent", args: ["mcp"], switchedOffBy: ["enabled" as const] };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("error");
  });

  it("names the off-PATH bin dir of a global install", () => {
    const result = classifyMcpEntry(
      { command: "argent", args: ["mcp"] },
      ctx({ globalOnPath: false, offPathGlobalBin: "/opt/npm-global/bin" })
    );
    expect(result.fix).toBe("Add /opt/npm-global/bin to PATH");
  });
});
