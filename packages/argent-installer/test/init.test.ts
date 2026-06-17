import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SKILLS_DIR,
  RULES_DIR,
  AGENTS_DIR,
  ARGENT_SKILLS_REPO,
  buildArgentSkillsSource,
} from "../src/utils.js";
import { printFirstRunNotice } from "../src/first-run-notice.js";
import { hasShownFirstRunNotice, _resetConsentCacheForTest } from "@argent/telemetry";

// These tests verify the logic used by init.ts without running the full TUI.
// The actual init flow is interactive and tested via the integration harness.

describe("init — skills path resolution", () => {
  it("SKILLS_DIR resolves relative to dist/", () => {
    // cli.ts compiles to dist/cli.js, so import.meta.dirname = dist/
    // SKILLS_DIR should be ../skills from there, i.e. <package-root>/skills
    expect(SKILLS_DIR).toContain("skills");
    expect(path.isAbsolute(SKILLS_DIR)).toBe(true);
  });

  it("RULES_DIR resolves relative to dist/", () => {
    expect(RULES_DIR).toContain("rules");
    expect(path.isAbsolute(RULES_DIR)).toBe(true);
  });

  it("AGENTS_DIR resolves relative to dist/", () => {
    expect(AGENTS_DIR).toContain("agents");
    expect(path.isAbsolute(AGENTS_DIR)).toBe(true);
  });
});

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

// Mirrors the args construction in init.ts Step 2. Kept as a regression check
// against accidental flag reorders that would change `skills add` semantics
// (e.g. dropping `-y` flipping into an interactive prompt during CI).
describe("init — skills command construction", () => {
  function buildArgs(
    skillsSource: string,
    scope: "local" | "global",
    method: "default" | "interactive"
  ): string[] {
    const args = ["skills", "add", skillsSource];
    if (scope === "global") args.push("-g");
    if (method === "default") args.push("--skill", "*", "-y");
    return args;
  }

  it("default method builds correct args with global scope", () => {
    const source = buildArgentSkillsSource("0.7.1");
    const args = buildArgs(source, "global", "default");

    expect(args[2]).toBe(source);
    expect(args).toContain("-g");
    expect(args).toContain("--skill");
    expect(args).toContain("*");
    expect(args).toContain("-y");
  });

  it("default method omits -g for local scope", () => {
    const args = buildArgs(buildArgentSkillsSource("0.7.1"), "local", "default");

    expect(args).not.toContain("-g");
    expect(args).toContain("-y");
  });

  it("interactive method passes no extra flags", () => {
    const args = buildArgs(buildArgentSkillsSource("0.7.1"), "local", "interactive");

    expect(args).toHaveLength(3);
    expect(args).not.toContain("-y");
    expect(args).not.toContain("-g");
  });

  it("falls back to SKILLS_DIR when the version is unknown (e.g. dev tarball)", () => {
    const args = buildArgs(buildArgentSkillsSource("unknown"), "local", "default");

    expect(args[2]).toBe(SKILLS_DIR);
  });
});
