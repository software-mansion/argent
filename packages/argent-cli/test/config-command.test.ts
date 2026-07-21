import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { config } from "../src/config.js";

// Real-filesystem integration test: drives the actual `config()` entry point
// against a sandboxed global home (HOME) and project cwd (a tmp dir with a
// `.git` marker so the project root resolves there). No fs mocks — this
// exercises the command → configuration-core → disk path end to end.

let homeDir: string;
let projectDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-cli-home-")));
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-cli-proj-")));
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalCwd = process.cwd();
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.chdir(projectDir);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  vi.restoreAllMocks();
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function output(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}
function errors(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

describe("argent config — set/get across scopes", () => {
  it("sets global and reads it back as the effective value", () => {
    config(["set", "lens.agent", "claude"]);
    logSpy.mockClear();
    config(["get", "lens.agent"]);
    expect(output()).toBe("claude");
    // Landed in the global config file.
    const globalCfg = JSON.parse(
      fs.readFileSync(path.join(homeDir, ".argent", "config.json"), "utf8")
    );
    expect(globalCfg).toEqual({ lens: { agent: "claude" } });
  });

  it("project scope overrides global under prioritize-local", () => {
    config(["set", "lens.agent", "claude", "--scope", "global"]);
    config(["set", "lens.agent", "codex", "--scope", "project"]);
    logSpy.mockClear();
    config(["get", "lens.agent"]);
    expect(output()).toBe("codex");
    // The project file lives under the project root, not HOME.
    const projCfg = JSON.parse(
      fs.readFileSync(path.join(projectDir, ".argent", "config.json"), "utf8")
    );
    expect(projCfg).toEqual({ lens: { agent: "codex" } });
  });

  it("get --scope shows only that scope's stored value", () => {
    config(["set", "lens.agent", "claude", "--scope", "global"]);
    config(["set", "lens.agent", "codex", "--scope", "project"]);
    logSpy.mockClear();
    config(["get", "lens.agent", "--scope", "global"]);
    expect(output()).toBe("claude");
    logSpy.mockClear();
    config(["get", "lens.agent", "--scope", "project"]);
    expect(output()).toBe("codex");
  });

  it("get prints (unset) for an absent value", () => {
    config(["get", "lens.agent"]);
    expect(output()).toBe("(unset)");
  });

  it("unset removes the value at a scope", () => {
    config(["set", "lens.agent", "claude"]);
    config(["unset", "lens.agent"]);
    logSpy.mockClear();
    config(["get", "lens.agent"]);
    expect(output()).toBe("(unset)");
  });

  it("set reports the normalized value that was stored", () => {
    config(["set", "lens.agent", "  codex  "]);
    // The message echoes the trimmed value that actually landed on disk.
    expect(output()).toContain("Set lens.agent = codex (global).");
    logSpy.mockClear();
    config(["get", "lens.agent"]);
    expect(output()).toBe("codex");
  });

  it("a no-op unset does not create the project config file", () => {
    const projectCfg = path.join(projectDir, ".argent", "config.json");
    config(["unset", "lens.agent", "--scope", "project"]);
    expect(output()).toContain("was not set at project scope");
    expect(fs.existsSync(projectCfg)).toBe(false);
  });
});

describe("argent config — validation & errors", () => {
  it("rejects an unknown key with exit 2 and a hint", () => {
    expect(() => config(["set", "does.not.exist", "1"])).toThrow(ExitError);
    expect(errors()).toMatch(/Unknown configuration key/);
    expect(errors()).toMatch(/argent config list/);
  });

  it("refuses to set a telemetry key, pointing at the dedicated command", () => {
    expect(() => config(["set", "telemetry.enabled", "false"])).toThrow(ExitError);
    expect(errors()).toMatch(/argent telemetry/);
  });

  it("rejects an invalid --scope", () => {
    expect(() => config(["get", "lens.agent", "--scope", "bogus"])).toThrow(ExitError);
    expect(errors()).toMatch(/--scope must be/);
  });

  it("rejects a value that fails the schema validator", () => {
    // lens.agent must be a non-blank string; a JSON number is invalid.
    expect(() => config(["set", "lens.agent", "42"])).toThrow(ExitError);
    expect(errors()).toMatch(/Invalid value/);
  });
});

describe("argent config — list & json", () => {
  it("list --json reports every schema entry with per-scope values", () => {
    config(["set", "lens.agent", "codex", "--scope", "project"]);
    logSpy.mockClear();
    config(["list", "--json"]);
    const parsed = JSON.parse(output());
    const lens = parsed.config.find((e: { key: string }) => e.key === "lens.agent");
    expect(lens.project).toBe("codex");
    expect(lens.effective).toBe("codex");
    const telemetry = parsed.config.find((e: { key: string }) => e.key === "telemetry.enabled");
    expect(telemetry.manageCommand).toBe("argent telemetry");
  });

  it("get --json emits a structured record", () => {
    config(["set", "lens.agent", "claude"]);
    logSpy.mockClear();
    config(["get", "lens.agent", "--json"]);
    expect(JSON.parse(output())).toEqual({
      key: "lens.agent",
      scope: "effective",
      value: "claude",
    });
  });
});
