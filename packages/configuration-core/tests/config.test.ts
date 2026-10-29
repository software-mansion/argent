import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { argentHomeDir, configFilePath } from "../src/paths.js";
import { configDocumentProblem, readConfigObject, updateConfig } from "../src/config.js";
import {
  getRememberedAgent,
  setRememberedAgent,
  clearRememberedAgent,
} from "../src/config-access.js";

// Redirect the `~/.argent` home into a tmp dir by mutating process.env.HOME
// (consumed by os.homedir() via argentHomeDir).
let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-config-home-")));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readConfigFile(): unknown {
  return JSON.parse(fs.readFileSync(configFilePath(), "utf8"));
}

describe("paths", () => {
  it("locates config.json under the argent home", () => {
    expect(configFilePath()).toBe(path.join(argentHomeDir(), "config.json"));
    expect(argentHomeDir()).toBe(path.join(tmpHome, ".argent"));
  });
});

describe("readConfigObject / updateConfig", () => {
  it("returns an empty object when the file is missing", () => {
    expect(readConfigObject()).toEqual({});
  });

  it("returns an empty object when the file is malformed", () => {
    fs.mkdirSync(argentHomeDir(), { recursive: true });
    fs.writeFileSync(configFilePath(), "not json{", "utf8");
    expect(readConfigObject()).toEqual({});
  });

  it("creates and persists a new key", () => {
    updateConfig((c) => {
      c.telemetry = { enabled: false };
    });
    expect(readConfigFile()).toEqual({ telemetry: { enabled: false } });
  });

  it("merges rather than clobbering keys it does not touch", () => {
    updateConfig((c) => {
      c.telemetry = { enabled: false };
    });
    updateConfig((c) => {
      c.notices = { firstRun: true };
    });
    expect(readConfigFile()).toEqual({
      telemetry: { enabled: false },
      notices: { firstRun: true },
    });
  });
});

describe("remembered agent (lens config)", () => {
  it("returns null when nothing is stored", () => {
    expect(getRememberedAgent()).toBeNull();
  });

  it("persists and reads back the chosen agent", () => {
    setRememberedAgent("claude");
    expect(getRememberedAgent()).toBe("claude");
    expect(readConfigFile()).toEqual({ lens: { agent: "claude" } });
  });

  it("overwrites a previously remembered agent", () => {
    setRememberedAgent("claude");
    setRememberedAgent("codex");
    expect(getRememberedAgent()).toBe("codex");
  });

  it("treats a blank stored agent as none", () => {
    updateConfig((c) => {
      c.lens = { agent: "   " };
    });
    expect(getRememberedAgent()).toBeNull();
  });

  it("clears the remembered agent without dropping sibling keys", () => {
    updateConfig((c) => {
      c.telemetry = { enabled: true };
    });
    setRememberedAgent("claude");
    clearRememberedAgent();
    expect(getRememberedAgent()).toBeNull();
    // Siblings survive; the emptied `lens` container does not.
    expect(readConfigFile()).toEqual({ telemetry: { enabled: true } });
  });

  it("clearing when nothing is stored is a no-op that doesn't throw", () => {
    expect(() => clearRememberedAgent()).not.toThrow();
    expect(getRememberedAgent()).toBeNull();
  });
});

// `readConfigObject` reads an absent, unreadable and unparseable file alike as
// an empty document, which is silent for a key with no default.
describe("configDocumentProblem", () => {
  it("says nothing for a host with no document or one that reads and parses", () => {
    expect(configDocumentProblem()).toBeUndefined();
    updateConfig((config) => ({ ...config, telemetry: { enabled: false } }));
    expect(configDocumentProblem()).toBeUndefined();
  });

  it.each([
    ["half-written JSON", '{"scripts":{"bash":"/bin/ba', "is not valid JSON"],
    ["a document that is not a JSON object", "[1,2,3]", "does not hold a JSON object"],
  ])("names the file and the problem for %s", (_label, document, says) => {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
    fs.writeFileSync(configFilePath(), document);

    const problem = configDocumentProblem();

    expect(problem).toContain(configFilePath());
    expect(problem).toContain(says);
    // The read itself is unchanged: still an empty document, still no throw.
    expect(readConfigObject()).toEqual({});
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "names the file and the read error for one it may not open",
    () => {
      fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
      fs.writeFileSync(configFilePath(), "{}");
      fs.chmodSync(configFilePath(), 0o000);
      try {
        expect(configDocumentProblem()).toContain("could not be read");
      } finally {
        fs.chmodSync(configFilePath(), 0o600);
      }
    }
  );
});
