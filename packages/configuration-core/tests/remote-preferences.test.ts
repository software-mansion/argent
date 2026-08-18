import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyRemotePreferenceFlags,
  buildRemotePreferencesSnapshot,
  clearRuntimeFlagOverrides,
  isFeatureEnabled,
  parseRemotePreferencesSnapshot,
  readFlags,
  setFlag,
  type FlagDefinition,
} from "../src/index.js";

const TEST_REGISTRY: readonly FlagDefinition[] = [
  { name: "client-only", description: "client" },
  { name: "remote-opt-in", description: "remote", syncToRemote: true },
  {
    name: "remote-opt-out",
    description: "remote default",
    syncToRemote: true,
    defaultEnabled: true,
  },
];

let tmpHome: string;
let tmpProject: string;

beforeEach(() => {
  clearRuntimeFlagOverrides();
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sync-home-")));
  tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sync-project-")));
  fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");
});

afterEach(() => {
  clearRuntimeFlagOverrides();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe("remote preference snapshots", () => {
  it("contains only effective live flags and the telemetry opt-out", () => {
    setFlag("client-only", true, "global", { homeDir: tmpHome });
    setFlag("remote-opt-in", true, "global", { homeDir: tmpHome });
    setFlag("remote-opt-out", false, "project", { cwd: tmpProject });

    expect(
      buildRemotePreferencesSnapshot(
        { homeDir: tmpHome, cwd: tmpProject, telemetryEnabled: false },
        TEST_REGISTRY
      )
    ).toEqual({
      version: 1,
      flags: { "remote-opt-in": true, "remote-opt-out": false },
      telemetryDisabled: true,
    });
  });

  it("never asks the remote server to enable telemetry", () => {
    expect(
      buildRemotePreferencesSnapshot(
        { homeDir: tmpHome, cwd: tmpProject, telemetryEnabled: true },
        TEST_REGISTRY
      )
    ).toMatchObject({ telemetryDisabled: false });
  });

  it("replaces a process overlay above project flags without writing files", () => {
    setFlag("remote-opt-in", false, "project", { cwd: tmpProject });
    applyRemotePreferenceFlags(
      {
        version: 1,
        flags: { "remote-opt-in": true, "client-only": true, "unknown": true },
        telemetryDisabled: false,
      },
      TEST_REGISTRY
    );

    expect(isFeatureEnabled("remote-opt-in", { cwd: tmpProject }, TEST_REGISTRY)).toBe(true);
    expect(readFlags("project", { cwd: tmpProject })).toEqual({ "remote-opt-in": false });
    expect(readFlags("global", { homeDir: tmpHome })).toEqual({});

    applyRemotePreferenceFlags({ version: 1, flags: {}, telemetryDisabled: false }, TEST_REGISTRY);
    expect(isFeatureEnabled("remote-opt-in", { cwd: tmpProject }, TEST_REGISTRY)).toBe(false);
  });

  it("rejects malformed payloads before application", () => {
    expect(() =>
      parseRemotePreferencesSnapshot({ version: 2, flags: {}, telemetryDisabled: false })
    ).toThrow(/Unsupported preference snapshot version/);
    expect(() =>
      parseRemotePreferencesSnapshot({
        version: 1,
        flags: { bad: "true" },
        telemetryDisabled: false,
      })
    ).toThrow(/must be boolean/);
    expect(() =>
      parseRemotePreferencesSnapshot({ version: 1, flags: {}, telemetryDisabled: "yes" })
    ).toThrow(/telemetryDisabled.*boolean/);
  });
});
