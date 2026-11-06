import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../src/utils/update-checker";

const pending: UpdateState = {
  updateAvailable: true,
  updateInstallable: true,
  installableVersion: "9.9.9",
  latestVersion: "9.9.9",
  latestPublishedAt: null,
  minReleaseAgeMs: 0,
  currentVersion: "1.0.0",
};

describe("dismiss-update", () => {
  let home: string;
  let originalHome: string | undefined;
  const file = () => path.join(home, ".argent", "update-suppression.json");

  async function load(state: Partial<UpdateState> = pending) {
    vi.resetModules();
    const checker = await import("../src/utils/update-checker");
    vi.spyOn(checker, "getUpdateState").mockReturnValue({ ...pending, ...state });
    const { dismissUpdateTool } = await import("../src/tools/system/dismiss-update");
    const run = (hours: number) => dismissUpdateTool.execute!({}, { hours }, {} as never);
    return { run, checker };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-06T12:00:00.000Z") });
    originalHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-dismiss-test-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns when reminders resume and that a pending version stays available", async () => {
    const { run } = await load();
    const result = await run(168);
    expect(result.remindersResumeAt).toBe("2026-11-13T12:00:00.000Z");
    expect(result.persisted).toBe(true);
    expect(result.pendingVersion).toBe("9.9.9");
    expect(result.message).toContain("nothing was installed");
    expect(JSON.parse(fs.readFileSync(file(), "utf8")).suppressUntil).toBe(
      Date.parse("2026-11-13T12:00:00.000Z")
    );
  });

  it("says when nothing is pending, without claiming a reminder was stopped", async () => {
    const { run } = await load({ updateInstallable: false, installableVersion: null });
    const result = await run(24);
    expect(result.pendingVersion).toBeNull();
    expect(result.message).toContain("No update is pending right now");
  });

  it("says it did not fully hold when ~/.argent cannot be written", async () => {
    fs.writeFileSync(path.join(home, ".argent"), "");
    const { run, checker } = await load();
    const result = await run(168);
    expect(result.persisted).toBe(false);
    expect(result.message).toContain("in this tool-server only");
    expect(checker.isUpdateNoteSuppressed()).toBe(true);
  });

  it("clamps a huge request to a real date that survives a restart", async () => {
    const { run } = await load();
    const result = await run(Number.MAX_VALUE);
    expect(result.remindersResumeAt).toBe("2036-11-03T12:00:00.000Z");
    const stored = JSON.parse(fs.readFileSync(file(), "utf8")).suppressUntil;
    expect(Number.isFinite(stored)).toBe(true);
  });

  it("turns reminders back on with 0 hours", async () => {
    const { run, checker } = await load();
    await run(168);
    expect(checker.isUpdateNoteSuppressed()).toBe(true);
    const result = await run(0);
    expect(result.remindersResumeAt).toBeNull();
    expect(checker.isUpdateNoteSuppressed()).toBe(false);
    expect(result.message).toContain("back on");
  });
});
