import { describe, it, expect, beforeEach, vi } from "vitest";

// runSkillsStep only decides and prints here: the runner, the network probe,
// prompts and telemetry are all stubbed, so no skills CLI ever runs.

const { resolveSkillsRunnerMock, promptsMock } = vi.hoisted(() => ({
  resolveSkillsRunnerMock: vi.fn(),
  promptsMock: {
    log: { step: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), message: vi.fn() },
    note: vi.fn(),
    select: vi.fn(),
    isCancel: vi.fn(() => false),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  },
}));

vi.mock("@clack/prompts", () => promptsMock);
vi.mock("@argent/telemetry", () => ({ track: vi.fn() }));

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return { ...actual, isOnline: vi.fn(async () => true) };
});

vi.mock("../src/skills-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/skills-runner.js")>();
  return { ...actual, resolveSkillsRunner: resolveSkillsRunnerMock };
});

import { runSkillsStep } from "../src/init-skills.js";

const baseArgs = { fromTar: null, version: "0.25.2", scope: "global" as const };

function noteText(): string {
  return promptsMock.note.mock.calls.map((call) => String(call[0])).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSkillsStep", () => {
  it("falls back to manual copy instructions, without a CLI command, when no runner is on PATH", async () => {
    resolveSkillsRunnerMock.mockReturnValue(null);

    const method = await runSkillsStep({ ...baseArgs, nonInteractive: true });

    expect(method).toBe("manual");
    expect(promptsMock.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Neither npx nor pnpm is on PATH")
    );
    expect(noteText()).toContain("cp -r");
    expect(noteText()).not.toContain("skills add");
  });

  it("offers the resolved runner's command in the manual instructions", async () => {
    resolveSkillsRunnerMock.mockReturnValue({
      kind: "pnpm",
      bin: "/usr/local/bin/pnpm",
      buildArgs: (args: string[]) => ["dlx", ...args],
      label: "pnpm dlx",
    });
    promptsMock.select.mockResolvedValue("manual");

    const method = await runSkillsStep({ ...baseArgs, nonInteractive: false });

    expect(method).toBe("manual");
    expect(noteText()).toContain("pnpm dlx skills add");
  });
});
