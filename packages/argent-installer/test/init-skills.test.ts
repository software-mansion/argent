import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Issue #614: skills are installed from a GitHub ref pinned to the running
 * version. Publishing and tagging are decoupled, so a published version whose
 * tag was never pushed can never resolve — the clone fails, nothing is
 * installed, and the run still reported "Skills installed" and exited 0.
 *
 * The package already ships every skill, so the bytes were on disk the whole
 * time; only the decision to use them was missing.
 */

const runNpxSkills = vi.hoisted(() => vi.fn(async (_args: string[]) => {}));
vi.mock("../src/npx-skills.js", () => ({ runNpxSkills }));

const isOnline = vi.hoisted(() => vi.fn(async () => true));
const isSkillsCliAvailable = vi.hoisted(() => vi.fn(() => true));
const listBundledSkills = vi.hoisted(() => vi.fn(() => ["argent-device-interact"]));

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  // buildArgentSkillsSource and SKILLS_DIR stay REAL so the argument
  // assertions below mean something.
  return { ...original, isOnline, isSkillsCliAvailable, listBundledSkills };
});

const track = vi.hoisted(() => vi.fn());
vi.mock("@argent/telemetry", () => ({ track }));

const log = vi.hoisted(() => ({
  step: vi.fn(),
  message: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
const note = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  log,
  note,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  select: vi.fn(async () => "default"),
  confirm: vi.fn(async () => true),
  isCancel: () => false,
}));

import { runSkillsStep } from "../src/init-skills.js";
import { SKILLS_DIR, buildArgentSkillsSource } from "../src/utils.js";

const PINNED = buildArgentSkillsSource("0.18.1");

function step(overrides: Record<string, unknown> = {}) {
  return runSkillsStep({
    scope: "local",
    version: "0.18.1",
    fromTar: null,
    yes: true,
    ...overrides,
  } as never);
}

/** The source argument of the Nth `npx skills add` attempt. */
function sourceOfAttempt(n: number): string {
  const args = runNpxSkills.mock.calls[n]![0];
  return args[args.indexOf("add") + 1]!;
}

const REPORTED_FAILURE = `npm WARN using --force Recommended protections disabled.
■  Failed to clone repository
│  fatal: Remote branch v0.18.1 not found in upstream origin`;

beforeEach(() => {
  vi.clearAllMocks();
  runNpxSkills.mockResolvedValue(undefined);
  isOnline.mockResolvedValue(true);
  isSkillsCliAvailable.mockReturnValue(true);
  listBundledSkills.mockReturnValue(["argent-device-interact"]);
});

describe("skills install falls back to the copy that ships with the package", () => {
  it("uses the pinned source when it works, and does not touch the bundled copy", async () => {
    const result = await step();

    expect(runNpxSkills).toHaveBeenCalledTimes(1);
    expect(sourceOfAttempt(0)).toBe(PINNED);
    expect(result).toMatchObject({ outcome: "success", source: "pinned", usedFallback: false });
  });

  it("installs the bundled copy when the pinned ref does not exist (issue #614)", async () => {
    runNpxSkills.mockRejectedValueOnce(new Error(REPORTED_FAILURE));

    const result = await step();

    expect(runNpxSkills).toHaveBeenCalledTimes(2);
    expect(sourceOfAttempt(0)).toBe(PINNED);
    expect(sourceOfAttempt(1)).toBe(SKILLS_DIR);
    expect(result).toMatchObject({ outcome: "success", source: "bundled", usedFallback: true });
    // The user is told, because their lock entry is now machine-local.
    expect(log.warn).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(
      "installation:skill_install",
      expect.objectContaining({ used_fallback: true, fallback_reason: "ref_missing" })
    );
  });

  it("falls back on any failure, not only one whose text it recognises", async () => {
    // The decision is structural: the interactive path captures no output to
    // match on, and git's wording is translated, so a text rule would silently
    // stop working outside an English toolchain.
    runNpxSkills.mockRejectedValueOnce(new Error("npx skills exited with code 1"));

    const result = await step();

    expect(result).toMatchObject({ outcome: "success", usedFallback: true });
    expect(track).toHaveBeenCalledWith(
      "installation:skill_install",
      expect.objectContaining({ fallback_reason: "unclassified" })
    );
  });

  it("does not retry a source that is already the bundled copy", async () => {
    // Offline, `--from <tgz>` and an unknown version all resolve to the bundled
    // copy up front — retrying it against itself would just fail twice.
    runNpxSkills.mockRejectedValue(new Error("boom"));

    const result = await step({ fromTar: "/tmp/argent.tgz" });

    expect(runNpxSkills).toHaveBeenCalledTimes(1);
    expect(sourceOfAttempt(0)).toBe(SKILLS_DIR);
    expect(result).toMatchObject({ outcome: "failure", usedFallback: false });
  });

  it("does not retry when the bundled copy is unreadable", async () => {
    // Retrying against an empty directory installs nothing and buries the real
    // problem behind a second, identical failure.
    listBundledSkills.mockReturnValue([]);
    runNpxSkills.mockRejectedValue(new Error(REPORTED_FAILURE));

    const result = await step();

    expect(runNpxSkills).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "failure" });
  });

  it("reports failure — and a command that could work — when both attempts fail", async () => {
    runNpxSkills.mockRejectedValue(new Error(REPORTED_FAILURE));

    const result = await step();

    expect(runNpxSkills).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ outcome: "failure", usedFallback: false });
    // Printing the failing command back as the remedy is what made the original
    // report so confusing.
    const hint = log.info.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("manually"))!;
    expect(hint).toContain(SKILLS_DIR);
    expect(hint).not.toContain(PINNED);
  });

  it("keeps the scope flag when it retries", async () => {
    runNpxSkills.mockRejectedValueOnce(new Error(REPORTED_FAILURE));

    await step({ scope: "global" });

    expect(runNpxSkills.mock.calls[1]![0]).toContain("-g");
  });
});
