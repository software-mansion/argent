import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { telemetry } from "../src/telemetry.js";
import { getConsentState, _resetConsentCacheForTest } from "@argent/telemetry";

// Real-filesystem test of `argent telemetry enable|disable [--scope]`: a
// sandboxed HOME (global scope) and a tmp project root (`.git` marker), so the
// restrictive project/global merge is exercised through the real command.
// Only the network client is stubbed — no events must leave the test.

vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return {
    ...actual,
    init: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  };
});

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let homeDir: string;
let projectDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-tel-home-")));
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-tel-proj-")));
  fs.mkdirSync(path.join(projectDir, ".git"));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalCwd = process.cwd();
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.chdir(projectDir);
  _resetConsentCacheForTest();
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
  _resetConsentCacheForTest();
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const globalConfig = () => readJson(path.join(homeDir, ".argent", "config.json"));
const projectConfig = () => readJson(path.join(projectDir, ".argent", "config.json"));
const output = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
const cleanEnv = { DO_NOT_TRACK: undefined, ARGENT_TELEMETRY: undefined };

describe("argent telemetry — scopes", () => {
  it("disable defaults to the global scope", async () => {
    await telemetry(["disable"]);
    expect(globalConfig()).toEqual({ telemetry: { enabled: false } });
    expect(projectConfig()).toBeNull();
    expect(output()).toContain("global scope");
  });

  it("disable --scope project writes the committed project file only", async () => {
    await telemetry(["disable", "--scope", "project"]);
    expect(projectConfig()).toEqual({ telemetry: { enabled: false } });
    expect(globalConfig()).toBeNull();
    const state = getConsentState(cleanEnv);
    expect(state.enabled).toBe(false);
    expect(state.source.detail).toBe("config.json (project)");
  });

  it("enable --scope=project alone cannot override a global opt-out (restrictive)", async () => {
    await telemetry(["disable"]);
    await telemetry(["enable", "--scope=project"]);
    expect(projectConfig()).toEqual({ telemetry: { enabled: true } });
    expect(getConsentState(cleanEnv).enabled).toBe(false);
    expect(output()).toContain("stays disabled");
  });

  it("a global enable cannot override a project opt-out", async () => {
    await telemetry(["disable", "--scope", "project"]);
    await telemetry(["enable"]);
    expect(globalConfig()).toEqual({ telemetry: { enabled: true } });
    expect(getConsentState(cleanEnv).enabled).toBe(false);
  });

  it("status names the document that opted out", async () => {
    await telemetry(["disable", "--scope", "project"]);
    logSpy.mockClear();
    await telemetry(["status"]);
    expect(output()).toContain("state:     disabled");
    expect(output()).toContain("config.json (project)");
  });

  it("rejects an unknown scope and an unknown argument", async () => {
    await expect(telemetry(["disable", "--scope", "team"])).rejects.toThrow("process.exit(2)");
    await expect(telemetry(["enable", "--force"])).rejects.toThrow("process.exit(2)");
    expect(errSpy).toHaveBeenCalled();
    expect(globalConfig()).toBeNull();
    expect(projectConfig()).toBeNull();
  });
});
