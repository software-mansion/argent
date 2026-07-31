import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activateRemotePreferences,
  asBoolean,
  buildRemotePreferencesSnapshot,
  clearRemotePreferences,
  getConfigValue,
  isFeatureEnabled,
  parseRemotePreferencesSnapshot,
  readConfigObject,
  readFlags,
  resolveRemotePreferences,
  setConfigValue,
  setFlag,
  type ConfigDefinition,
  type FlagDefinition,
} from "../src/index.js";

const TEST_FLAGS: readonly FlagDefinition[] = [
  { name: "client-only", description: "client" },
  { name: "remote-opt-in", description: "remote", remoteSync: "live" },
  {
    name: "remote-opt-out",
    description: "remote default",
    remoteSync: "live",
    defaultEnabled: true,
  },
];

const REMOTE_CONFIG: ConfigDefinition = {
  key: "privacy.enabled",
  description: "privacy",
  scopes: ["global"],
  parse: asBoolean,
  merge: "prioritize-local",
  default: true,
  remoteSync: "opt-out-only",
};
const CLIENT_CONFIG: ConfigDefinition = {
  key: "client.enabled",
  description: "client",
  scopes: ["global"],
  parse: asBoolean,
  merge: "prioritize-local",
};
const TEST_CONFIG: readonly ConfigDefinition[] = [REMOTE_CONFIG, CLIENT_CONFIG];

let tmpHome: string;
let tmpProject: string;

beforeEach(() => {
  clearRemotePreferences();
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sync-home-")));
  tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sync-project-")));
  fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");
});

afterEach(() => {
  clearRemotePreferences();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe("remote preference snapshots", () => {
  it("contains only schema-allowlisted effective values and opt-outs", () => {
    setFlag("client-only", true, "global", { homeDir: tmpHome });
    setFlag("remote-opt-in", true, "global", { homeDir: tmpHome });
    setFlag("remote-opt-out", false, "project", { cwd: tmpProject });

    expect(
      buildRemotePreferencesSnapshot(
        {
          homeDir: tmpHome,
          cwd: tmpProject,
          effectiveConfig: { "privacy.enabled": false, "client.enabled": true },
        },
        TEST_FLAGS,
        TEST_CONFIG
      )
    ).toEqual({
      version: 1,
      flags: { "remote-opt-in": true, "remote-opt-out": false },
      config: { "privacy.enabled": false },
    });
  });

  it("does not propagate opt-out-only enablement", () => {
    expect(
      buildRemotePreferencesSnapshot(
        {
          homeDir: tmpHome,
          cwd: tmpProject,
          effectiveConfig: { "privacy.enabled": true },
        },
        TEST_FLAGS,
        TEST_CONFIG
      )
    ).toEqual({
      version: 1,
      flags: { "remote-opt-in": false, "remote-opt-out": true },
      config: {},
    });
  });

  it("uses a process overlay above remote project values without writing files", () => {
    setFlag("remote-opt-in", false, "project", { cwd: tmpProject });
    setConfigValue("privacy.enabled", true, "global", { homeDir: tmpHome }, TEST_CONFIG);

    const resolved = resolveRemotePreferences(
      {
        version: 1,
        flags: { "remote-opt-in": true, "client-only": true, "unknown": true },
        config: { "privacy.enabled": false, "client.enabled": true, "unknown": "value" },
      },
      TEST_FLAGS,
      TEST_CONFIG
    );
    activateRemotePreferences(resolved);

    expect(resolved).toMatchObject({
      appliedFlags: ["remote-opt-in"],
      ignoredFlags: ["client-only", "unknown"],
      appliedConfig: ["privacy.enabled"],
      ignoredConfig: ["client.enabled", "unknown"],
    });
    expect(isFeatureEnabled("remote-opt-in", { cwd: tmpProject }, TEST_FLAGS)).toBe(true);
    expect(getConfigValue(REMOTE_CONFIG, { homeDir: tmpHome })).toBe(false);
    expect(readFlags("project", { cwd: tmpProject })).toEqual({ "remote-opt-in": false });
    expect(readFlags("global", { homeDir: tmpHome })).toEqual({});
    expect(readConfigObject("global", { homeDir: tmpHome })).toEqual({
      privacy: { enabled: true },
    });

    activateRemotePreferences(
      resolveRemotePreferences({ version: 1, flags: {}, config: {} }, TEST_FLAGS, TEST_CONFIG)
    );
    expect(isFeatureEnabled("remote-opt-in", { cwd: tmpProject }, TEST_FLAGS)).toBe(false);
    expect(getConfigValue(REMOTE_CONFIG, { homeDir: tmpHome })).toBe(true);
  });

  it("validates the full snapshot before anything can be activated", () => {
    expect(() =>
      resolveRemotePreferences(
        {
          version: 1,
          flags: { "remote-opt-in": true },
          config: { "privacy.enabled": true },
        },
        TEST_FLAGS,
        TEST_CONFIG
      )
    ).toThrow(/may only be false/);
    expect(isFeatureEnabled("remote-opt-in", { cwd: tmpProject }, TEST_FLAGS)).toBe(false);
  });

  it("rejects malformed envelopes while tolerating unknown config keys", () => {
    expect(() => parseRemotePreferencesSnapshot({ version: 2, flags: {}, config: {} })).toThrow(
      /Unsupported preference snapshot version/
    );
    expect(() =>
      parseRemotePreferencesSnapshot({ version: 1, flags: { bad: "true" }, config: {} })
    ).toThrow(/must be boolean/);
    expect(() => parseRemotePreferencesSnapshot({ version: 1, flags: {} })).toThrow(
      /field "config" must be an object/
    );
    expect(
      parseRemotePreferencesSnapshot({
        version: 1,
        flags: {},
        config: { "future.value": { shape: "unknown" } },
      })
    ).toMatchObject({ config: { "future.value": { shape: "unknown" } } });
  });
});
