import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { scopeHome, snapshotEnv } from "./helpers.js";
import { writeConsentFlag, _resetConsentCacheForTest } from "../src/consent.js";
import {
  FIRST_RUN_NOTICE,
  TELEMETRY_OPT_OUT_COMMAND,
  TELEMETRY_DETAILS_URL,
  hasShownFirstRunNotice,
  markFirstRunNoticeShown,
  resetFirstRunNotice,
  shouldShowFirstRunNotice,
} from "../src/notice.js";
import { resetLocalTelemetryState } from "../src/uninstall-reset.js";
import { configFilePath } from "../src/paths.js";

describe("first-run notice", () => {
  scopeHome();
  const restoreEnv = () => snapshotEnv(["DO_NOT_TRACK", "ARGENT_TELEMETRY"]);

  function readConfig(): {
    telemetry?: { enabled?: boolean };
    notices?: { first_run_shown?: boolean };
  } {
    return JSON.parse(fs.readFileSync(configFilePath(), "utf8"));
  }

  it("has not been shown on a fresh install (no config file)", () => {
    expect(hasShownFirstRunNotice()).toBe(false);
  });

  it("reads true once the marker is persisted", () => {
    markFirstRunNoticeShown();
    expect(hasShownFirstRunNotice()).toBe(true);
  });

  it("preserves the telemetry consent flag when marking the notice shown", () => {
    writeConsentFlag(false);
    markFirstRunNoticeShown();
    const config = readConfig();
    expect(config.telemetry?.enabled).toBe(false);
    expect(config.notices?.first_run_shown).toBe(true);
  });

  it("should show when telemetry is enabled and the notice is unseen", () => {
    const restore = restoreEnv();
    try {
      delete process.env.DO_NOT_TRACK;
      delete process.env.ARGENT_TELEMETRY;
      _resetConsentCacheForTest();
      expect(shouldShowFirstRunNotice()).toBe(true);
      markFirstRunNoticeShown();
      expect(shouldShowFirstRunNotice()).toBe(false);
    } finally {
      restore();
    }
  });

  it("should not show when telemetry is disabled, and does not mark it shown", () => {
    const restore = restoreEnv();
    try {
      process.env.ARGENT_TELEMETRY = "0";
      _resetConsentCacheForTest();
      expect(shouldShowFirstRunNotice()).toBe(false);
      expect(hasShownFirstRunNotice()).toBe(false);
    } finally {
      restore();
    }
  });

  describe("resetFirstRunNotice", () => {
    it("clears the marker so the notice shows again on reinstall", () => {
      markFirstRunNoticeShown();
      expect(hasShownFirstRunNotice()).toBe(true);
      resetFirstRunNotice();
      expect(hasShownFirstRunNotice()).toBe(false);
    });

    it("leaves a persisted opt-out untouched so it survives a reinstall", () => {
      writeConsentFlag(false);
      markFirstRunNoticeShown();
      resetFirstRunNotice();
      const config = readConfig();
      expect(config.notices?.first_run_shown).toBeUndefined();
      expect(config.telemetry?.enabled).toBe(false);
    });

    it("is a no-op when nothing was recorded (creates no config file)", () => {
      resetFirstRunNotice();
      expect(fs.existsSync(configFilePath())).toBe(false);
    });

    it("is run by resetLocalTelemetryState() so uninstall resets the marker", async () => {
      markFirstRunNoticeShown();
      await resetLocalTelemetryState();
      expect(hasShownFirstRunNotice()).toBe(false);
    });
  });

  it("exposes the notice copy with the opt-out command and details URL", () => {
    expect(FIRST_RUN_NOTICE).toContain(TELEMETRY_OPT_OUT_COMMAND);
    expect(FIRST_RUN_NOTICE).toContain(TELEMETRY_DETAILS_URL);
  });
});
