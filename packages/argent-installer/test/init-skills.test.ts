import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// `runSkillsStep` spawns `npx skills add ...`. Mock `spawn` with a child that
// exits 0 so the test can inspect the spawn options without running npx.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock },
    spawn: spawnMock,
  };
});

vi.mock("@argent/telemetry", () => ({ track: vi.fn() }));

vi.mock("../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils.js")>();
  return { ...actual, isOnline: vi.fn(async () => true) };
});

import { runSkillsStep } from "../src/init-skills.js";

const originalPackage = process.env.npm_config_package;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    setImmediate(() => child.emit("close", 0));
    return child;
  });
});

afterEach(() => {
  if (originalPackage === undefined) delete process.env.npm_config_package;
  else process.env.npm_config_package = originalPackage;
});

describe("runSkillsStep", () => {
  it("runs `npx skills add` without an inherited npm_config_package (#1335)", async () => {
    // Set by `npx --package @swmansion/argent -- argent init`.
    process.env.npm_config_package = "@swmansion/argent@latest";

    const method = await runSkillsStep({
      nonInteractive: true,
      fromTar: null,
      version: "unknown",
      scope: "global",
    });

    expect(method).toBe("default");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(args).toContain("skills");
    expect(args).toContain("add");
    expect(opts.env).toBeDefined();
    expect(opts.env).not.toHaveProperty("npm_config_package");
  });
});
