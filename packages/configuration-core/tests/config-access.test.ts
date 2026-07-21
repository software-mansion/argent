import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { configFilePath } from "../src/paths.js";
import { readConfigObject, getAtPath, setAtPath, deleteAtPath } from "../src/config.js";
import {
  getConfigValue,
  getConfigValueByKey,
  setConfigValue,
  unsetConfigValue,
  listConfig,
  coerceCliValue,
  UnknownConfigKeyError,
  ConfigScopeError,
  ConfigValidationError,
  ConfigManagedElsewhereError,
} from "../src/config-access.js";
import type { ConfigDefinition } from "../src/config-schema.js";

// Sandbox both scopes: `homeDir` for global (~/.argent), `cwd` for the project
// root (a tmp dir seeded with a `.git` marker so resolveProjectRoot stops there).
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-home-")));
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-project-")));
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

const opts = () => ({ homeDir, cwd: projectDir });

describe("dotted-path helpers", () => {
  it("gets, sets, and deletes nested leaves", () => {
    const obj: Record<string, unknown> = {};
    setAtPath(obj, "ios.deviceSet", "/tmp/set");
    expect(obj).toEqual({ ios: { deviceSet: "/tmp/set" } });
    expect(getAtPath(obj, "ios.deviceSet")).toBe("/tmp/set");
    expect(deleteAtPath(obj, "ios.deviceSet")).toBe(true);
    expect(obj).toEqual({ ios: {} });
    expect(deleteAtPath(obj, "ios.deviceSet")).toBe(false);
  });

  it("refuses prototype-polluting segments", () => {
    const obj: Record<string, unknown> = {};
    expect(() => setAtPath(obj, "__proto__.polluted", true)).toThrow(/forbidden/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("getConfigValue — scope merge (lens.agent = prioritize-local)", () => {
  it("returns null-equivalent (undefined) when neither scope is set", () => {
    expect(getConfigValueByKey("lens.agent", opts())).toBeUndefined();
  });

  it("reads the global value when only global is set", () => {
    setConfigValue("lens.agent", "claude", "global", opts());
    expect(getConfigValueByKey("lens.agent", opts())).toBe("claude");
  });

  it("project overrides global under prioritize-local", () => {
    setConfigValue("lens.agent", "claude", "global", opts());
    setConfigValue("lens.agent", "codex", "project", opts());
    expect(getConfigValueByKey("lens.agent", opts())).toBe("codex");
    // Each scope's file holds only its own value.
    expect(readConfigObject("global", opts())).toEqual({ lens: { agent: "claude" } });
    expect(readConfigObject("project", opts())).toEqual({ lens: { agent: "codex" } });
  });

  it("writes project config under <project-root>/.argent/config.json", () => {
    setConfigValue("lens.agent", "codex", "project", opts());
    expect(fs.existsSync(configFilePath("project", opts()))).toBe(true);
    expect(configFilePath("project", opts())).toBe(path.join(projectDir, ".argent", "config.json"));
  });
});

describe("setConfigValue — validation", () => {
  it("rejects an unknown key", () => {
    expect(() => setConfigValue("nope.nope", "x", "global", opts())).toThrow(UnknownConfigKeyError);
  });

  it("rejects a project write for a global-only value via ConfigScopeError", () => {
    // A settable, global-only definition supplied through the registry param
    // (telemetry.enabled is global-only too, but it's manageCommand-delegated so
    // it throws ConfigManagedElsewhereError first — this isolates the scope check).
    const registry: ConfigDefinition[] = [
      {
        key: "test.onlyGlobal",
        description: "test",
        scopes: ["global"],
        parse: (r) => (typeof r === "boolean" ? r : undefined),
        merge: "prioritize-restrictive",
      },
    ];
    expect(() => setConfigValue("test.onlyGlobal", true, "project", opts(), registry)).toThrow(
      ConfigScopeError
    );
    // Global scope is accepted.
    expect(() => setConfigValue("test.onlyGlobal", true, "global", opts(), registry)).not.toThrow();
  });

  it("refuses to set a manageCommand-delegated key (telemetry)", () => {
    expect(() => setConfigValue("telemetry.enabled", false, "global", opts())).toThrow(
      ConfigManagedElsewhereError
    );
    expect(() => unsetConfigValue("telemetry.enabled", "global", opts())).toThrow(
      ConfigManagedElsewhereError
    );
  });

  it("rejects an invalid value shape", () => {
    // lens.agent expects a non-blank string.
    expect(() => setConfigValue("lens.agent", 42, "global", opts())).toThrow(ConfigValidationError);
    expect(() => setConfigValue("lens.agent", "   ", "global", opts())).toThrow(
      ConfigValidationError
    );
  });
});

describe("unsetConfigValue", () => {
  it("removes a stored value and reports whether anything was removed", () => {
    setConfigValue("lens.agent", "claude", "global", opts());
    expect(unsetConfigValue("lens.agent", "global", opts())).toBe(true);
    expect(getConfigValueByKey("lens.agent", opts())).toBeUndefined();
    expect(unsetConfigValue("lens.agent", "global", opts())).toBe(false);
  });
});

describe("listConfig", () => {
  it("reports every schema entry with per-scope and effective values", () => {
    setConfigValue("lens.agent", "claude", "global", opts());
    setConfigValue("lens.agent", "codex", "project", opts());
    const entries = listConfig(opts());
    const lens = entries.find((e) => e.key === "lens.agent")!;
    expect(lens.global).toBe("claude");
    expect(lens.project).toBe("codex");
    expect(lens.effective).toBe("codex");
    const telemetry = entries.find((e) => e.key === "telemetry.enabled")!;
    expect(telemetry.manageCommand).toBe("argent telemetry");
    expect(telemetry.scopes).toEqual(["global"]);
  });
});

describe("coerceCliValue", () => {
  it("parses JSON scalars and arrays, falling back to a bare string", () => {
    expect(coerceCliValue("true")).toBe(true);
    expect(coerceCliValue("42")).toBe(42);
    expect(coerceCliValue('["a","b"]')).toEqual(["a", "b"]);
    expect(coerceCliValue("/tmp/device-set")).toBe("/tmp/device-set");
    expect(coerceCliValue("claude")).toBe("claude");
  });
});

describe("getConfigValue — direct definition + custom-typed default", () => {
  it("applies the schema default when no scope contributes a value", () => {
    const def: ConfigDefinition<string> = {
      key: "demo.value",
      description: "demo",
      scopes: ["project", "global"],
      parse: (r) => (typeof r === "string" && r.trim() ? r.trim() : undefined),
      merge: "prioritize-local",
      default: "fallback",
    };
    expect(getConfigValue(def, opts())).toBe("fallback");
  });
});
