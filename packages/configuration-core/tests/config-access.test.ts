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
  getConfigDefinition,
  MIN_SCRIPT_HEAP_LIMIT_MB,
  MIN_SCRIPT_TIMEOUT_MS,
  WINDOWS_ROOTED_PATH_RE,
  type ConfigDefinition,
} from "../src/config-schema.js";

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

describe("scripts.env.allow — schema entry", () => {
  it("is unset by default", () => {
    expect(getConfigValueByKey("scripts.env.allow", opts())).toBeUndefined();
  });

  it("unions both scopes — a project names what its own scripts read", () => {
    setConfigValue("scripts.env.allow", ["AWS_PROFILE"], "global", opts());
    setConfigValue("scripts.env.allow", ["DATABASE_URL"], "project", opts());
    expect(getConfigValueByKey("scripts.env.allow", opts())).toEqual([
      "AWS_PROFILE",
      "DATABASE_URL",
    ]);
  });

  it("takes both scopes, unlike the global-only host bounds", () => {
    expect(getConfigDefinition("scripts.env.allow")?.scopes).toEqual(["project", "global"]);
    expect(getConfigDefinition("scripts.maxTimeoutMs")?.scopes).toEqual(["global"]);
    expect(getConfigDefinition("scripts.heapLimitMb")?.scopes).toEqual(["global"]);
  });

  it("drops a blank or non-string entry when the file is read", () => {
    expect(
      setConfigValue("scripts.env.allow", ["  DATABASE_URL  ", "  "], "project", opts())
    ).toEqual(["DATABASE_URL"]);
  });
});

describe("setConfigValue — validation", () => {
  it("rejects an unknown key", () => {
    expect(() => setConfigValue("nope.nope", "x", "global", opts())).toThrow(UnknownConfigKeyError);
  });

  it("rejects a project write for a global-only value via ConfigScopeError", () => {
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
    expect(unsetConfigValue("lens.agent", "project", opts())).toBe(false);
    expect(fs.existsSync(projectConfig)).toBe(false);
  });
});

describe("setConfigValue — return value", () => {
  it("returns the normalized (stored) value, not the raw input", () => {
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
      path.join(homeDir, "shared"),
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
    for (const def of CONFIG_SCHEMA) {
      if (!def.example) continue;
      expect(
        (def.validateWrite ?? def.parse)(coerceCliValue(def.example)),
        `key: ${def.key}`
      ).not.toBeUndefined();
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

describe("flow script host bounds", () => {
  it("refuses a heap limit too small for a Node process to start", () => {
    expect(() => setConfigValue("scripts.heapLimitMb", 2, "global", opts())).toThrow(
      ConfigValidationError
    );
    expect(() => setConfigValue("scripts.heapLimitMb", 16, "global", opts())).toThrow(
      ConfigValidationError
    );
    expect(setConfigValue("scripts.heapLimitMb", MIN_SCRIPT_HEAP_LIMIT_MB, "global", opts())).toBe(
      MIN_SCRIPT_HEAP_LIMIT_MB
    );
  });

  it("refuses a ceiling the step spends on starting its own process", () => {
    expect(() => setConfigValue("scripts.maxTimeoutMs", 30, "global", opts())).toThrow(
      ConfigValidationError
    );
    expect(() => setConfigValue("scripts.maxTimeoutMs", 99, "global", opts())).toThrow(
      ConfigValidationError
    );
    expect(setConfigValue("scripts.maxTimeoutMs", MIN_SCRIPT_TIMEOUT_MS, "global", opts())).toBe(
      MIN_SCRIPT_TIMEOUT_MS
    );
  });

  it.each([
    ["scripts.heapLimitMb", MIN_SCRIPT_HEAP_LIMIT_MB],
    ["scripts.maxTimeoutMs", MIN_SCRIPT_TIMEOUT_MS],
  ])("says what %s wants when it refuses one", (key, min) => {
    const def = getConfigDefinition(key)!;
    expect(describeExpectedValue(def)).toContain(`at least ${min}`);
  });

  it.each(["scripts.maxTimeoutMs", "scripts.heapLimitMb"])(
    "keeps %s out of project scope, so repository content cannot raise its own ceiling",
    (key) => {
      const def = getConfigDefinition(key)!;
      expect(def.scopes).toEqual(["global"]);
      expect(() => setConfigValue(key, 60_000, "project", opts())).toThrow();
    }
  );
});

describe("scripts.bash — schema entry", () => {
  const configured = path.join(path.sep, "opt", "homebrew", "bin", "bash");

  it("keeps a wrong hand-edited value so the resolver can name it", () => {
    const file = configFilePath("global", opts());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ scripts: { bash: "bin/bash" } }));

    expect(getConfigValueByKey("scripts.bash", opts())).toBe("bin/bash");
  });

  it("reads a null as an unset key rather than as the text null", () => {
    const file = configFilePath("global", opts());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ scripts: { bash: null } }));

    expect(getConfigValueByKey("scripts.bash", opts())).toBeUndefined();
  });

  it.each([
    ["a value that is not a string", 42],
    ["a value that is not text at all", { a: 1 }],
    ["a boolean", true],
    ["an empty value", ""],
    ["a whitespace-only value", "   "],
    ["a relative path", path.join("bin", "bash")],
  ])("refuses %s being typed in, though the reader would keep it", (_label, value) => {
    expect(() => setConfigValue("scripts.bash", value, "global", opts())).toThrow(
      ConfigValidationError
    );
    expect(readConfigObject("global", opts())).toEqual({});
  });

  it("accepts an absolute path, trimmed", () => {
    expect(setConfigValue("scripts.bash", `  ${configured}  `, "global", opts())).toBe(configured);
    expect(readConfigObject("global", opts())).toEqual({ scripts: { bash: configured } });
  });

  it("takes the global scope only, and does not read a committed project value", () => {
    const def = getConfigDefinition("scripts.bash")!;
    expect(def.scopes).toEqual(["global"]);
    const projectFile = configFilePath("project", opts());
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(
      projectFile,
      JSON.stringify({ scripts: { bash: "C:\\Program Files\\Git\\bin\\bash.exe" } })
    );

    expect(getConfigValueByKey("scripts.bash", opts())).toBeUndefined();
  });

  it("refuses a write at the project scope", () => {
    expect(() => setConfigValue("scripts.bash", configured, "project", opts())).toThrow(
      ConfigScopeError
    );
    expect(readConfigObject("project", opts())).toEqual({});
  });

  it.runIf(process.platform !== "win32")("offers an example this host really has", () => {
    const def = getConfigDefinition("scripts.bash")!;

    expect(fs.existsSync(def.example!)).toBe(true);
    expect(describeExpectedValue(def)).toContain(def.example);
  });

  it("says what it wants when it refuses one", () => {
    const expected = describeExpectedValue(getConfigDefinition("scripts.bash")!);
    expect(expected).toContain("an absolute path to Bash");
    expect(expected).toContain("the tool-server host");
    expect(expected).toContain("on Windows");
  });

  describe("under Windows rules", () => {
    const realPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    });

    it.each([
      ["a drive-rooted path", "C:\\Program Files\\Git\\bin\\bash.exe"],
      ["a drive-rooted path with forward slashes", "C:/Program Files/Git/bin/bash.exe"],
      ["a UNC share", "\\\\build01\\tools\\git\\bin\\bash.exe"],
    ])("writes %s", (_label, value) => {
      expect(setConfigValue("scripts.bash", value, "global", opts())).toBe(value);
      expect(readConfigObject("global", opts())).toEqual({ scripts: { bash: value } });
    });

    it.each([
      // `path.win32.isAbsolute` says true for both of these, and neither names
      // a drive - so the step would refuse a value the write gate had accepted.
      ["a POSIX path", "/usr/bin/bash"],
      ["a path rooted on no drive", "\\Git\\bin\\bash.exe"],
      ["a relative path", "bin\\bash.exe"],
    ])("refuses %s", (_label, value) => {
      expect(() => setConfigValue("scripts.bash", value, "global", opts())).toThrow(
        ConfigValidationError
      );
      expect(readConfigObject("global", opts())).toEqual({});
    });

    it("uses the same rooted-path rule the tool server reads back", () => {
      expect(WINDOWS_ROOTED_PATH_RE.test("C:\\Git\\bin\\bash.exe")).toBe(true);
      expect(WINDOWS_ROOTED_PATH_RE.test("/usr/bin/bash")).toBe(false);
    });
  });
});
