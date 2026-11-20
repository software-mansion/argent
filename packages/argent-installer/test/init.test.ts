import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SKILLS_DIR, ARGENT_SKILLS_REPO, buildArgentSkillsSource } from "../src/utils.js";
import * as p from "@clack/prompts";
import { printFirstRunNotice, resolveTelemetryConsent } from "../src/first-run-notice.js";
import {
  hasShownFirstRunNotice,
  markFirstRunNoticeShown,
  isEnabled,
  _resetConsentCacheForTest,
} from "@argent/telemetry";

// Real clack `select` reads stdin and can't run headless; stub it (and isCancel)
// while keeping the rest of the module (log.* writes to the mocked stdout).
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, select: vi.fn(), isCancel: vi.fn(() => false) };
});

// These tests verify the logic used by init.ts without running the full TUI.
// The actual init flow is interactive and tested via the integration harness.

describe("printFirstRunNotice", () => {
  let tmp: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedArgentTelemetry: string | undefined;
  let savedDoNotTrack: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argent-installer-notice-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedArgentTelemetry = process.env.ARGENT_TELEMETRY;
    savedDoNotTrack = process.env.DO_NOT_TRACK;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    delete process.env.ARGENT_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    _resetConsentCacheForTest();
    // Keep clack output from polluting the test reporter.
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const restore = (
      key: "HOME" | "USERPROFILE" | "ARGENT_TELEMETRY" | "DO_NOT_TRACK",
      value: string | undefined
    ) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("HOME", savedHome);
    restore("USERPROFILE", savedUserProfile);
    restore("ARGENT_TELEMETRY", savedArgentTelemetry);
    restore("DO_NOT_TRACK", savedDoNotTrack);
    _resetConsentCacheForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("marks the notice shown on first run and is a no-op afterwards", () => {
    expect(hasShownFirstRunNotice()).toBe(false);
    printFirstRunNotice();
    expect(hasShownFirstRunNotice()).toBe(true);
    // Second call must not throw and the marker stays set.
    printFirstRunNotice();
    expect(hasShownFirstRunNotice()).toBe(true);
  });

  it("does not mark the notice shown when telemetry is opted out", () => {
    process.env.ARGENT_TELEMETRY = "0";
    _resetConsentCacheForTest();
    printFirstRunNotice();
    expect(hasShownFirstRunNotice()).toBe(false);
  });
});

describe("resolveTelemetryConsent", () => {
  let tmp: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedArgentTelemetry: string | undefined;
  let savedDoNotTrack: string | undefined;

  const readConfig = (): Record<string, any> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(tmp, ".argent", "config.json"), "utf8"));
    } catch {
      return {};
    }
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argent-installer-consent-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedArgentTelemetry = process.env.ARGENT_TELEMETRY;
    savedDoNotTrack = process.env.DO_NOT_TRACK;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    delete process.env.ARGENT_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    _resetConsentCacheForTest();
    vi.mocked(p.select).mockReset();
    vi.mocked(p.isCancel).mockReset();
    vi.mocked(p.isCancel).mockReturnValue(false);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const restore = (
      key: "HOME" | "USERPROFILE" | "ARGENT_TELEMETRY" | "DO_NOT_TRACK",
      value: string | undefined
    ) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("HOME", savedHome);
    restore("USERPROFILE", savedUserProfile);
    restore("ARGENT_TELEMETRY", savedArgentTelemetry);
    restore("DO_NOT_TRACK", savedDoNotTrack);
    _resetConsentCacheForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("--no-telemetry disables and marks shown without prompting (any mode)", async () => {
    const result = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: true });
    expect(result).toEqual({ kind: "disabled", reason: "flag" });
    expect(p.select).not.toHaveBeenCalled();
    expect(readConfig().telemetry?.enabled).toBe(false);
    expect(isEnabled()).toBe(false);
    expect(hasShownFirstRunNotice()).toBe(true);
  });

  it("non-interactive keeps the default and only surfaces the notice", async () => {
    const result = await resolveTelemetryConsent({ nonInteractive: true, disableFlag: false });
    expect(result).toEqual({ kind: "skipped" });
    expect(p.select).not.toHaveBeenCalled();
    // No persisted override — still default-on.
    expect(readConfig().telemetry?.enabled).toBeUndefined();
    expect(isEnabled()).toBe(true);
    expect(hasShownFirstRunNotice()).toBe(true);
  });

  it("does not prompt when an env override owns the decision", async () => {
    process.env.ARGENT_TELEMETRY = "0";
    _resetConsentCacheForTest();
    const result = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: false });
    expect(result).toEqual({ kind: "skipped" });
    expect(p.select).not.toHaveBeenCalled();
    expect(hasShownFirstRunNotice()).toBe(false);
  });

  it("does not re-prompt once a choice was made on a previous install", async () => {
    markFirstRunNoticeShown();
    const result = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: false });
    expect(result).toEqual({ kind: "skipped" });
    expect(p.select).not.toHaveBeenCalled();
  });

  it("an interactive Enabled choice is effective immediately but only persists on commit", async () => {
    vi.mocked(p.select).mockResolvedValue("enabled");
    const result = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: false });
    expect(result.kind).toBe("enabled");
    // Effective for the session via the in-process override...
    expect(isEnabled()).toBe(true);
    // ...but nothing is on disk until the install commits.
    expect(readConfig().telemetry?.enabled).toBeUndefined();
    expect(hasShownFirstRunNotice()).toBe(false);

    if (result.kind === "enabled") result.commit();
    expect(readConfig().telemetry?.enabled).toBe(true);
    expect(isEnabled()).toBe(true);
    expect(hasShownFirstRunNotice()).toBe(true);
  });

  it("an interactive Disabled choice suppresses the session immediately but only persists on commit", async () => {
    vi.mocked(p.select).mockResolvedValue("disabled");
    const result = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: false });
    expect(result).toMatchObject({ kind: "disabled", reason: "choice" });
    // Session is already opted out even though nothing is on disk yet.
    expect(isEnabled()).toBe(false);
    expect(readConfig().telemetry?.enabled).toBeUndefined();
    expect(hasShownFirstRunNotice()).toBe(false);

    if (result.kind === "disabled" && result.reason === "choice") result.commit();
    expect(readConfig().telemetry?.enabled).toBe(false);
    expect(isEnabled()).toBe(false);
    expect(hasShownFirstRunNotice()).toBe(true);
  });

  it("re-prompts on the next run when a prior choice was never committed (aborted init)", async () => {
    // First run: the user picks Enabled but aborts before init commits.
    vi.mocked(p.select).mockResolvedValue("enabled");
    const first = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: false });
    expect(first.kind).toBe("enabled");
    // No commit() — the install was abandoned.

    // A fresh process clears the in-process override and re-reads disk, which
    // still carries no decision. _resetConsentCacheForTest models that restart.
    _resetConsentCacheForTest();
    expect(hasShownFirstRunNotice()).toBe(false);
    expect(readConfig().telemetry?.enabled).toBeUndefined();

    // Second run: must ask again rather than inherit the abandoned "enabled".
    vi.mocked(p.select).mockResolvedValue("disabled");
    const second = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: false });
    expect(p.select).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ kind: "disabled", reason: "choice" });
  });

  it("cancelling the prompt persists nothing and reports cancelled", async () => {
    const cancelSymbol = Symbol("clack:cancel");
    vi.mocked(p.select).mockResolvedValue(cancelSymbol as never);
    vi.mocked(p.isCancel).mockReturnValue(true);
    const result = await resolveTelemetryConsent({ nonInteractive: false, disableFlag: false });
    expect(result).toEqual({ kind: "cancelled" });
    expect(readConfig().telemetry?.enabled).toBeUndefined();
    expect(hasShownFirstRunNotice()).toBe(false);
  });
});

describe("buildArgentSkillsSource", () => {
  it("returns the github shorthand pinned to v<version> for a clean semver", () => {
    expect(buildArgentSkillsSource("0.7.1")).toBe(`${ARGENT_SKILLS_REPO}#v0.7.1`);
  });

  it("preserves pre-release identifiers in the pinned tag", () => {
    expect(buildArgentSkillsSource("0.6.0-next.0")).toBe(`${ARGENT_SKILLS_REPO}#v0.6.0-next.0`);
  });

  it("falls back to SKILLS_DIR when the version is unknown", () => {
    expect(buildArgentSkillsSource("unknown")).toBe(SKILLS_DIR);
  });

  it("falls back to SKILLS_DIR when no version is supplied", () => {
    expect(buildArgentSkillsSource(null)).toBe(SKILLS_DIR);
    expect(buildArgentSkillsSource(undefined)).toBe(SKILLS_DIR);
    expect(buildArgentSkillsSource("")).toBe(SKILLS_DIR);
  });
});
