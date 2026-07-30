import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyRemotePreferenceFlags,
  buildRemotePreferencesSnapshot,
  parseRemotePreferencesSnapshot,
  readFlags,
  setFlag,
  type FlagDefinition,
} from "../src/index.js";

const TEST_REGISTRY: readonly FlagDefinition[] = [
  { name: "client-only", description: "client" },
  { name: "remote-opt-in", description: "remote", remoteSync: "live" },
  {
    name: "remote-opt-out",
    description: "remote default",
    remoteSync: "live",
    defaultEnabled: true,
  },
];

let tmpHome: string;
let tmpProject: string;

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sync-home-")));
  tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-sync-project-")));
  fs.writeFileSync(path.join(tmpProject, "package.json"), "{}");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe("remote preference snapshots", () => {
  it("contains only effective live server flags and a telemetry opt-out", () => {
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
      telemetry: { enabled: false },
    });
  });

  it("does not propagate telemetry enablement", () => {
    expect(
      buildRemotePreferencesSnapshot(
        { homeDir: tmpHome, cwd: tmpProject, telemetryEnabled: true },
        TEST_REGISTRY
      )
    ).toEqual({
      version: 1,
      flags: { "remote-opt-in": false, "remote-opt-out": true },
    });
  });

  it("applies only keys the receiver marks remotely syncable", () => {
    const result = applyRemotePreferenceFlags(
      { version: 1, flags: { "remote-opt-in": true, "client-only": true, "unknown": true } },
      { homeDir: tmpHome },
      TEST_REGISTRY
    );

    expect(result).toEqual({
      appliedFlags: ["remote-opt-in"],
      ignoredFlags: ["client-only", "unknown"],
    });
    expect(readFlags("global", { homeDir: tmpHome })).toEqual({ "remote-opt-in": true });
  });

  it("rejects malformed and telemetry-enabling payloads", () => {
    expect(() => parseRemotePreferencesSnapshot({ version: 2, flags: {} })).toThrow(
      /Unsupported preference snapshot version/
    );
    expect(() => parseRemotePreferencesSnapshot({ version: 1, flags: { bad: "true" } })).toThrow(
      /must be boolean/
    );
    expect(() =>
      parseRemotePreferencesSnapshot({ version: 1, flags: {}, telemetry: { enabled: true } })
    ).toThrow(/may only be false/);
  });
});
