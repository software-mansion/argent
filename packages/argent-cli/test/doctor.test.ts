import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyMcpEntry,
  renderDoctorReport,
  stripPackageBinDirs,
  toolchainChecks,
  type EntryContext,
} from "../src/doctor.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argent-doctor-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function ctx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    projectRoot,
    globalOnPath: true,
    localInstalled: false,
    argentCommand: "argent",
    globalInstallFix: "npm install -g @swmansion/argent",
    projectInstallFix: "npm install",
    ...overrides,
  };
}

describe("classifyMcpEntry", () => {
  const bare = { command: "argent", args: ["mcp"] };

  it("accepts `argent mcp` when argent is on PATH", () => {
    expect(classifyMcpEntry(bare, ctx()).status).toBe("ok");
  });

  it("fails `argent mcp` when argent is not on PATH and points at the global install", () => {
    const result = classifyMcpEntry(bare, ctx({ globalOnPath: false }));
    expect(result.status).toBe("error");
    expect(result.fix).toBe("npm install -g @swmansion/argent");
  });

  it("only warns when the entry's own env may let the editor find argent", () => {
    const entry = { ...bare, env: { PATH: "/custom/bin" } };
    expect(classifyMcpEntry(entry, ctx({ globalOnPath: false })).status).toBe("warn");
  });

  it("checks a node entry's script relative to the project root", () => {
    const script = "node_modules/@swmansion/argent/dist/cli.js";
    const entry = { command: "node", args: [script, "mcp"] };
    const missing = classifyMcpEntry(entry, ctx());
    expect(missing.status).toBe("error");
    expect(missing.fix).toBe("npm install");

    fs.mkdirSync(path.dirname(path.join(projectRoot, script)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, script), "");
    expect(classifyMcpEntry(entry, ctx()).status).toBe("ok");
  });

  it("needs a local or global install for `npx argent mcp` but not for the scoped package", () => {
    const local = { command: "npx", args: ["--no-install", "argent", "mcp"] };
    const nothing = ctx({ globalOnPath: false });
    expect(classifyMcpEntry(local, nothing).status).toBe("error");
    expect(classifyMcpEntry(local, { ...nothing, localInstalled: true }).status).toBe("ok");
    expect(classifyMcpEntry(local, ctx()).status).toBe("ok");
    const onDemand = { command: "npx", args: ["-y", "@swmansion/argent@latest", "mcp"] };
    expect(classifyMcpEntry(onDemand, nothing).status).toBe("ok");
  });

  it("fails an absolute command that no longer exists", () => {
    const entry = { command: path.join(projectRoot, "gone", "argent"), args: ["mcp"] };
    expect(classifyMcpEntry(entry, ctx()).status).toBe("error");
  });

  it("warns about an entry it could not read", () => {
    expect(classifyMcpEntry({ command: "", args: [] }, ctx()).status).toBe("warn");
  });
});

describe("toolchainChecks", () => {
  const adb = "/sdk/platform-tools/adb";

  it("passes with Xcode selected and adb found", () => {
    const checks = toolchainChecks({
      adb,
      xcode: { developerDir: "/Applications/Xcode.app/Contents/Developer", simctl: true },
    });
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok"]);
  });

  it("tells the user to select Xcode when only the Command Line Tools are active", () => {
    const [ios] = toolchainChecks({
      adb,
      xcode: { developerDir: "/Library/Developer/CommandLineTools", simctl: false },
    });
    expect(ios!.status).toBe("warn");
    expect(ios!.fix).toContain("xcode-select -s");
  });

  it("warns when adb is missing and skips iOS off macOS", () => {
    const [ios, android] = toolchainChecks({ adb: null, xcode: null });
    expect(ios!.status).toBe("info");
    expect(android!.status).toBe("warn");
    expect(android!.fix).toContain("ANDROID_HOME");
  });
});

describe("stripPackageBinDirs", () => {
  it("drops node_modules/.bin so a project copy does not pass for a global install", () => {
    const value = ["/proj/node_modules/.bin", "/usr/local/bin", "/usr/bin"].join(path.delimiter);
    expect(stripPackageBinDirs(value)).toBe(["/usr/local/bin", "/usr/bin"].join(path.delimiter));
  });
});

describe("renderDoctorReport", () => {
  it("prints the fix under a failing check and counts errors and warnings", () => {
    const output = renderDoctorReport({
      version: "1.0.0",
      projectRoot,
      sections: [
        {
          title: "Editors (MCP config)",
          checks: [
            { status: "error", label: "Cursor: argent mcp", fix: "npm install -g x" },
            { status: "warn", label: "Rules missing", fix: "argent init" },
            { status: "ok", label: "Claude Code: argent mcp", fix: "never shown" },
          ],
        },
      ],
    });
    expect(output).toContain("npm install -g x");
    expect(output).not.toContain("never shown");
    expect(output).toContain("1 error, 1 warning");
  });
});
