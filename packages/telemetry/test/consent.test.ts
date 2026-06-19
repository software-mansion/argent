import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { scopeHome, snapshotEnv } from "./helpers.js";
import {
  getConsentState,
  isEnabled,
  writeConsentFlag,
  _resetConsentCacheForTest,
} from "../src/consent.js";
import { configFilePath } from "../src/paths.js";

describe("consent", () => {
  const { tmp } = scopeHome();
  const restoreEnv = () =>
    snapshotEnv([
      "DO_NOT_TRACK",
      "ARGENT_TELEMETRY",
      "CI",
      "GITHUB_ACTIONS",
      "GITLAB_CI",
      "CONTINUOUS_INTEGRATION",
      "BUILD_NUMBER",
      "RUN_ID",
      "CIRCLECI",
      "TRAVIS",
      "JENKINS_URL",
      "JENKINS_HOME",
      "TEAMCITY_VERSION",
      "BUILDKITE",
      "BITBUCKET_BUILD_NUMBER",
      "CODEBUILD_BUILD_ID",
      "TF_BUILD",
      "VERCEL",
      "NETLIFY",
      "DRONE",
      "APPVEYOR",
    ]);

  function emptyEnv(): NodeJS.ProcessEnv {
    return {};
  }

  it("defaults to enabled in an empty env / no config file", () => {
    const restore = restoreEnv();
    try {
      expect(getConsentState(emptyEnv()).enabled).toBe(true);
      expect(getConsentState(emptyEnv()).source.source).toBe("default");
    } finally {
      restore();
    }
  });

  it("DO_NOT_TRACK=1 disables (consortium standard)", () => {
    const restore = restoreEnv();
    try {
      expect(getConsentState({ DO_NOT_TRACK: "1" }).enabled).toBe(false);
      expect(getConsentState({ DO_NOT_TRACK: "true" }).enabled).toBe(false);
    } finally {
      restore();
    }
  });

  it("DO_NOT_TRACK disables for any present, non-off value (not just 1/true)", () => {
    const restore = restoreEnv();
    try {
      // The DNT convention is "present and not 0/empty" ⇒ opt out, so an
      // unrecognized token must still disable rather than fall through to on.
      for (const value of ["2", "yes", "on", "enabled", "  1  "]) {
        const state = getConsentState({ DO_NOT_TRACK: value });
        expect(state.enabled).toBe(false);
        expect(state.source.source).toBe("env_do_not_track");
        expect(state.source.detail).toBe(`DO_NOT_TRACK=${value}`);
      }
    } finally {
      restore();
    }
  });

  it("DO_NOT_TRACK does not opt out when empty or explicitly off", () => {
    const restore = restoreEnv();
    try {
      // Empty / unset and the explicit off tokens must NOT be treated as DNT;
      // these fall through to the default-on (no config / session override here).
      for (const value of ["", "   ", "0", "false", "no", "off"]) {
        const state = getConsentState({ DO_NOT_TRACK: value });
        expect(state.enabled).toBe(true);
        expect(state.source.source).not.toBe("env_do_not_track");
      }
    } finally {
      restore();
    }
  });

  it("ARGENT_TELEMETRY=0 disables", () => {
    const restore = restoreEnv();
    try {
      expect(getConsentState({ ARGENT_TELEMETRY: "0" }).enabled).toBe(false);
      expect(getConsentState({ ARGENT_TELEMETRY: "false" }).enabled).toBe(false);
    } finally {
      restore();
    }
  });

  it.each(["CI", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_HOME", "TF_BUILD"])(
    "%s=1 does not auto-disable",
    (envName) => {
      const restore = restoreEnv();
      try {
        const state = getConsentState({ [envName]: "1" });
        expect(state.enabled).toBe(true);
        expect(state.source.source).toBe("default");
      } finally {
        restore();
      }
    }
  );

  it("respects persisted config.json", () => {
    const restore = restoreEnv();
    try {
      _resetConsentCacheForTest();
      writeConsentFlag(false);
      expect(isEnabled(emptyEnv())).toBe(false);
      expect(getConsentState(emptyEnv()).source.source).toBe("config_file");
      _resetConsentCacheForTest();
      writeConsentFlag(true);
      expect(isEnabled(emptyEnv())).toBe(true);
    } finally {
      restore();
    }
  });

  it("re-reads the config file when mtime changes", () => {
    const restore = restoreEnv();
    try {
      _resetConsentCacheForTest();
      writeConsentFlag(true);
      expect(isEnabled(emptyEnv())).toBe(true);

      // Manually rewrite to disabled; bumping mtime to a future second so
      // the cache invalidates even on macOS HFS+'s 1 s granularity.
      const future = new Date(Date.now() + 5_000);
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({ telemetry: { enabled: false } }, null, 2) + "\n"
      );
      fs.utimesSync(configFilePath(), future, future);
      expect(isEnabled(emptyEnv())).toBe(false);
    } finally {
      restore();
    }
  });

  it("re-reads on an opt-out even if the mtime is unchanged (size busts the cache)", () => {
    const restore = restoreEnv();
    try {
      _resetConsentCacheForTest();
      writeConsentFlag(true);
      expect(isEnabled(emptyEnv())).toBe(true);

      // Pin the mtime: simulate a coarse-granularity filesystem / same-tick
      // in-place edit where the mtime does NOT advance. Toggling enabled
      // true→false still changes the byte length, so the cache must invalidate.
      const stat = fs.statSync(configFilePath());
      fs.writeFileSync(
        configFilePath(),
        JSON.stringify({ telemetry: { enabled: false } }, null, 2) + "\n"
      );
      fs.utimesSync(configFilePath(), stat.atime, stat.mtime);

      expect(isEnabled(emptyEnv())).toBe(false);
    } finally {
      restore();
    }
  });

  it("treats a malformed config.json as no override (does NOT enable silently)", () => {
    const restore = restoreEnv();
    try {
      _resetConsentCacheForTest();
      // Manually write garbage
      fs.mkdirSync(tmp() + "/.argent", { recursive: true });
      fs.writeFileSync(configFilePath(), "{ this is not json");
      expect(isEnabled(emptyEnv())).toBe(true); // falls back to default-on, fine
      // Important: source must NOT claim config_file as the reason.
      expect(getConsentState(emptyEnv()).source.source).toBe("default");
    } finally {
      restore();
    }
  });

  it("rejects a symlink at the config path", () => {
    const restore = restoreEnv();
    try {
      _resetConsentCacheForTest();
      fs.mkdirSync(tmp() + "/.argent", { recursive: true });
      const fake = tmp() + "/elsewhere.json";
      fs.writeFileSync(fake, JSON.stringify({ telemetry: { enabled: false } }));
      fs.symlinkSync(fake, configFilePath());
      // Symlink at the target → treated as missing, default-on.
      expect(isEnabled(emptyEnv())).toBe(true);
    } finally {
      restore();
    }
  });

  it("env override beats persisted config", () => {
    const restore = restoreEnv();
    try {
      _resetConsentCacheForTest();
      writeConsentFlag(true);
      expect(getConsentState({ DO_NOT_TRACK: "1" }).enabled).toBe(false);
      expect(getConsentState({ ARGENT_TELEMETRY: "0" }).enabled).toBe(false);
    } finally {
      restore();
    }
  });

  it("explicit env opt-outs still disable in CI", () => {
    const restore = restoreEnv();
    try {
      expect(getConsentState({ CI: "1", DO_NOT_TRACK: "1" }).enabled).toBe(false);
      expect(getConsentState({ CI: "1", DO_NOT_TRACK: "1" }).source.source).toBe(
        "env_do_not_track"
      );
      expect(getConsentState({ CI: "1", ARGENT_TELEMETRY: "0" }).enabled).toBe(false);
      expect(getConsentState({ CI: "1", ARGENT_TELEMETRY: "0" }).source.source).toBe(
        "env_argent_telemetry"
      );
    } finally {
      restore();
    }
  });
});
