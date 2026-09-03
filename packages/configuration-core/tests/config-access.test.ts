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
  getAdditionalIosDeviceSets,
  UnknownConfigKeyError,
  ConfigScopeError,
  ConfigValidationError,
  ConfigManagedElsewhereError,
} from "../src/config-access.js";
import {
  CONFIG_SCHEMA,
  describeExpectedValue,
  type ConfigDefinition,
} from "../src/config-schema.js";

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
    // The emptied parent goes with it, so unset restores the prior document.
    expect(obj).toEqual({});
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

describe("recordings.directory — schema entry", () => {
  it("is unset by default (the client then uses its built-in .argent/recordings)", () => {
    expect(getConfigValueByKey("recordings.directory", opts())).toBeUndefined();
  });

  it("accepts a path at either scope and trims it", () => {
    expect(setConfigValue("recordings.directory", "  ~/Movies/argent  ", "global", opts())).toBe(
      "~/Movies/argent"
    );
    expect(setConfigValue("recordings.directory", "clips", "project", opts())).toBe("clips");
  });

  it("project scope wins over global (prioritize-local)", () => {
    setConfigValue("recordings.directory", "/global/recordings", "global", opts());
    setConfigValue("recordings.directory", "/project/recordings", "project", opts());
    expect(getConfigValueByKey("recordings.directory", opts())).toBe("/project/recordings");
    unsetConfigValue("recordings.directory", "project", opts());
    expect(getConfigValueByKey("recordings.directory", opts())).toBe("/global/recordings");
  });

  it("rejects a non-string value", () => {
    expect(() => setConfigValue("recordings.directory", 42, "global", opts())).toThrow(
      ConfigValidationError
    );
  });
});

describe("setConfigValue — validation", () => {
  it("rejects an unknown key", () => {
    expect(() => setConfigValue("nope.nope", "x", "global", opts())).toThrow(UnknownConfigKeyError);
  });

  it("rejects a project write for a global-only value via ConfigScopeError", () => {
    // A settable, global-only definition supplied through the registry param
    // (no shipped key is global-only any more, so a synthetic one isolates the
    // scope check).
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

  it("a no-op unset never materializes the scope's config file", () => {
    const projectConfig = configFilePath("project", opts());
    expect(fs.existsSync(projectConfig)).toBe(false);
    // Nothing is stored at the project scope, so this removes nothing…
    expect(unsetConfigValue("lens.agent", "project", opts())).toBe(false);
    // …and must not create <project-root>/.argent/config.json to prove it.
    expect(fs.existsSync(projectConfig)).toBe(false);
  });
});

describe("setConfigValue — return value", () => {
  it("returns the normalized (stored) value, not the raw input", () => {
    // asString trims, so the stored/returned value is the trimmed form.
    expect(setConfigValue("lens.agent", "  codex  ", "global", opts())).toBe("codex");
    expect(getConfigValueByKey("lens.agent", opts())).toBe("codex");
  });
});

describe("getConfigValue — allowlist.enabled (prioritize-restrictive, no default)", () => {
  it("reads as unset when never decided", () => {
    expect(getConfigValueByKey("allowlist.enabled", opts())).toBeUndefined();
  });

  it("false in either scope wins over true in the other", () => {
    setConfigValue("allowlist.enabled", true, "global", opts());
    setConfigValue("allowlist.enabled", false, "project", opts());
    expect(getConfigValueByKey("allowlist.enabled", opts())).toBe(false);

    setConfigValue("allowlist.enabled", false, "global", opts());
    setConfigValue("allowlist.enabled", true, "project", opts());
    expect(getConfigValueByKey("allowlist.enabled", opts())).toBe(false);
  });

  it("a lone true opts in", () => {
    setConfigValue("allowlist.enabled", true, "global", opts());
    expect(getConfigValueByKey("allowlist.enabled", opts())).toBe(true);
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
    expect(telemetry.scopes).toEqual(["project", "global"]);
  });
});

describe("telemetry.enabled — opt-out default", () => {
  it("reads as true (the opt-out default) when nothing is stored", () => {
    expect(getConfigValueByKey("telemetry.enabled", opts())).toBe(true);
    const entry = listConfig(opts()).find((e) => e.key === "telemetry.enabled")!;
    expect(entry.effective).toBe(true);
    expect(entry.global).toBeUndefined();
  });

  it("reflects a persisted opt-out from the global config file", () => {
    // Written by hand — `setConfigValue` refuses manageCommand-delegated keys,
    // matching how `argent telemetry disable` owns this write in production.
    fs.mkdirSync(path.join(homeDir, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".argent", "config.json"),
      JSON.stringify({ telemetry: { enabled: false } })
    );
    expect(getConfigValueByKey("telemetry.enabled", opts())).toBe(false);
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

describe("ios.additionalDeviceSets — additive union across scopes", () => {
  it("reads as an empty list when neither scope is set", () => {
    expect(getAdditionalIosDeviceSets(opts())).toEqual([]);
    expect(getConfigValueByKey("ios.additionalDeviceSets", opts())).toBeUndefined();
  });

  it("unions the scopes additively: global baseline first, project extras after, deduped", () => {
    setConfigValue("ios.additionalDeviceSets", ["/tmp/sets/a", "/tmp/sets/b"], "global", opts());
    setConfigValue("ios.additionalDeviceSets", ["/tmp/sets/b", "/tmp/sets/c"], "project", opts());
    expect(getConfigValueByKey("ios.additionalDeviceSets", opts())).toEqual([
      "/tmp/sets/a",
      "/tmp/sets/b",
      "/tmp/sets/c",
    ]);
    // Each scope's file holds only its own entries — the union is read-time.
    expect(readConfigObject("global", opts())).toEqual({
      ios: { additionalDeviceSets: ["/tmp/sets/a", "/tmp/sets/b"] },
    });
    expect(readConfigObject("project", opts())).toEqual({
      ios: { additionalDeviceSets: ["/tmp/sets/b", "/tmp/sets/c"] },
    });
  });

  it("rejects a non-array value; normalizes entries (trims, drops blanks/non-strings)", () => {
    expect(() =>
      setConfigValue("ios.additionalDeviceSets", "/tmp/sets/a", "global", opts())
    ).toThrow(ConfigValidationError);
    expect(
      setConfigValue("ios.additionalDeviceSets", ["  /tmp/sets/a ", "", 42], "global", opts())
    ).toEqual(["/tmp/sets/a"]);
  });

  it("getAdditionalIosDeviceSets expands ~ and resolves relative entries per scope", () => {
    setConfigValue("ios.additionalDeviceSets", ["~/DeviceSets/ci", "shared"], "global", opts());
    setConfigValue("ios.additionalDeviceSets", ["device-sets/e2e", "/abs/set"], "project", opts());
    expect(getAdditionalIosDeviceSets(opts())).toEqual([
      path.join(homeDir, "DeviceSets/ci"),
      // Relative global entries resolve against home…
      path.join(homeDir, "shared"),
      // …while relative project entries resolve against the project root.
      path.join(projectDir, "device-sets/e2e"),
      path.resolve("/abs/set"),
    ]);
  });

  it("drops duplicates that only converge after normalization", () => {
    setConfigValue("ios.additionalDeviceSets", ["~/DeviceSets/ci"], "global", opts());
    setConfigValue(
      "ios.additionalDeviceSets",
      [path.join(homeDir, "DeviceSets", "ci")],
      "project",
      opts()
    );
    expect(getAdditionalIosDeviceSets(opts())).toEqual([path.join(homeDir, "DeviceSets/ci")]);
  });

  it("strips trailing separators so slash-suffixed spellings dedup too", () => {
    setConfigValue("ios.additionalDeviceSets", ["~/DeviceSets/ci/"], "global", opts());
    setConfigValue(
      "ios.additionalDeviceSets",
      [path.join(homeDir, "DeviceSets", "ci"), "~"],
      "project",
      opts()
    );
    expect(getAdditionalIosDeviceSets(opts())).toEqual([
      path.join(homeDir, "DeviceSets/ci"),
      // Bare `~` resolves to home without a trailing separator either.
      homeDir,
    ]);
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

describe("every schema entry can describe itself", () => {
  it("says what value it expects", () => {
    for (const def of CONFIG_SCHEMA) {
      expect(describeExpectedValue(def), `key: ${def.key}`).toBeTruthy();
    }
  });

  it("offers an example for every key a user may set", () => {
    for (const def of CONFIG_SCHEMA) {
      if (def.manageCommand) continue;
      expect(def.example, `key: ${def.key}`).toBeTruthy();
    }
  });

  it("offers examples that are actually accepted", () => {
    // An example that its own validator rejects would hand the user a command
    // reproducing the error it exists to fix.
    for (const def of CONFIG_SCHEMA) {
      if (!def.example) continue;
      expect(def.parse(coerceCliValue(def.example)), `key: ${def.key}`).not.toBeUndefined();
    }
  });
});

describe("deleteAtPath prunes only what it emptied", () => {
  it("removes a container the delete emptied", () => {
    const obj: Record<string, unknown> = { ios: { additionalDeviceSets: ["/a"] } };
    expect(deleteAtPath(obj, "ios.additionalDeviceSets")).toBe(true);
    expect(obj).toEqual({});
  });

  it("stops at the first ancestor that still holds something", () => {
    const obj: Record<string, unknown> = { ios: { deviceSet: "x", additionalDeviceSets: ["/a"] } };
    expect(deleteAtPath(obj, "ios.additionalDeviceSets")).toBe(true);
    expect(obj).toEqual({ ios: { deviceSet: "x" } });
  });

  it("unwinds a chain deeper than one level", () => {
    const obj: Record<string, unknown> = { a: { b: { c: { d: 1 } } } };
    expect(deleteAtPath(obj, "a.b.c.d")).toBe(true);
    expect(obj).toEqual({});
  });

  it("keeps a sibling group intact while unwinding", () => {
    const obj: Record<string, unknown> = { a: { b: { c: 1 } }, keep: { x: 1 } };
    expect(deleteAtPath(obj, "a.b.c")).toBe(true);
    expect(obj).toEqual({ keep: { x: 1 } });
  });

  it("leaves an empty array sibling alone", () => {
    const obj: Record<string, unknown> = { a: { list: [], gone: 1 } };
    expect(deleteAtPath(obj, "a.gone")).toBe(true);
    expect(obj).toEqual({ a: { list: [] } });
  });

  it("empties the root object rather than removing it", () => {
    const obj: Record<string, unknown> = { lens: { agent: "claude" } };
    expect(deleteAtPath(obj, "lens.agent")).toBe(true);
    expect(obj).toEqual({});
  });

  it("changes nothing when the path does not resolve", () => {
    const obj: Record<string, unknown> = { ios: { deviceSet: "x" } };
    expect(deleteAtPath(obj, "ios.missing")).toBe(false);
    expect(deleteAtPath(obj, "nope.missing")).toBe(false);
    expect(obj).toEqual({ ios: { deviceSet: "x" } });
  });
});
