import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock child_process and update-checker before importing the module under test.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(),
}));

import { spawn } from "node:child_process";
import { getUpdateState } from "../src/utils/update-checker";

const mockSpawn = vi.mocked(spawn);
const mockGetUpdateState = vi.mocked(getUpdateState);

interface FakeChild {
  unref: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  // captured 'error' handler so tests can replay an ENOENT scenario
  errorHandler?: (err: Error) => void;
}

function makeChild(): FakeChild {
  const child: FakeChild = {
    unref: vi.fn(),
    on: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === "error") child.errorHandler = handler;
      return child;
    }),
  };
  return child;
}

function stateWithUpdate(latestVersion = "99.0.0") {
  return {
    updateAvailable: true,
    currentVersion: "1.0.0",
    latestVersion,
  };
}

function stateUpToDate() {
  return {
    updateAvailable: false,
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
  };
}

describe("update-argent tool", () => {
  // Re-import per test so the module-level `updateScheduled` flag resets.
  let updateArgentTool: typeof import("../src/tools/system/update-argent").updateArgentTool;
  let originalCwd: () => string;
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    mockSpawn.mockReturnValue(makeChild() as unknown as ReturnType<typeof spawn>);
    mockGetUpdateState.mockReturnValue(stateWithUpdate());

    // Each test gets a fresh tmpDir as a synthetic project root.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-argent-tool-"));
    originalCwd = process.cwd;
    process.cwd = () => tmpDir;

    const mod = await import("../src/tools/system/update-argent");
    updateArgentTool = mod.updateArgentTool;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    process.cwd = originalCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── PATH fallback (no local devDep) ────────────────────────────────────

  it("returns a message with current and latest version on success", async () => {
    const result = await updateArgentTool.execute({}, undefined, undefined);
    expect((result as { message: string }).message).toContain("1.0.0 -> v99.0.0");
    expect((result as { message: string }).message).toContain("restart");
  });

  it("falls back to PATH lookup ('argent') when no local devDep exists", async () => {
    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [bin, args, opts] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe("argent");
    expect(args).toEqual(["update", "--yes"]);
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
    // No cwd override when falling back to PATH — let the child inherit
    // whatever the tool-server's cwd is (preserves historical behavior).
    expect((opts as { cwd?: string }).cwd).toBeUndefined();
  });

  it("does NOT spawn before 2 seconds have elapsed", async () => {
    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(1999);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("calls unref() on the child process", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    expect(child.unref).toHaveBeenCalledOnce();
  });

  // ── Local devDep resolution ────────────────────────────────────────────

  it("uses the project-local devDep binary when node_modules/.bin/argent exists", async () => {
    // Stage a fake local install — the file just needs to exist; the
    // tool doesn't try to execute it during the test (spawn is mocked).
    const binDir = path.join(tmpDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binName = process.platform === "win32" ? "argent.cmd" : "argent";
    const localBin = path.join(binDir, binName);
    fs.writeFileSync(localBin, "");

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [bin, args, opts] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe(localBin);
    expect(args).toEqual(["update", "--yes"]);
    // The child runs with cwd = project root so `argent update`'s own
    // project-root resolution (lockfile probe, dep declaration check)
    // matches what `argent init` saw.
    expect((opts as { cwd?: string }).cwd).toBe(tmpDir);
  });

  // ── Error visibility ───────────────────────────────────────────────────

  it("attaches an 'error' handler so future ENOENT failures aren't silent", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    // Verify the handler was registered (not just that .on was called).
    const errorRegistration = child.on.mock.calls.find((c) => c[0] === "error");
    expect(errorRegistration).toBeDefined();
    expect(typeof errorRegistration![1]).toBe("function");
  });

  it("writes spawn failures to stderr so the log retains a trace", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    // Replay the kernel sending an ENOENT to the parent process.
    child.errorHandler?.(Object.assign(new Error("spawn argent ENOENT"), { code: "ENOENT" }));

    expect(stderrWrite).toHaveBeenCalled();
    const written = stderrWrite.mock.calls[0]![0] as string;
    expect(written).toContain("[argent]");
    expect(written).toContain("ENOENT");

    stderrWrite.mockRestore();
  });

  it("clears the updateScheduled flag on spawn error so the user can retry", async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);
    // Replay an ENOENT — without the flag-reset, the tool would
    // permanently report "update already in progress" until the
    // tool-server restarted.
    child.errorHandler?.(new Error("spawn argent ENOENT"));

    // Reset spawn mock so we can observe whether the second call spawns again.
    mockSpawn.mockClear();
    mockSpawn.mockReturnValue(makeChild() as unknown as ReturnType<typeof spawn>);

    const second = await updateArgentTool.execute({}, undefined, undefined);
    vi.advanceTimersByTime(2000);

    expect((second as { message: string }).message).not.toContain("already in progress");
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  // ── Pre-existing behaviors preserved ───────────────────────────────────

  it("returns 'already up to date' when no update is available", async () => {
    mockGetUpdateState.mockReturnValue(stateUpToDate());

    const result = await updateArgentTool.execute({}, undefined, undefined);
    expect((result as { message: string }).message).toContain("already up to date");
    vi.advanceTimersByTime(5000);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 'already in progress' and does not double-spawn on second call", async () => {
    await updateArgentTool.execute({}, undefined, undefined);
    const second = await updateArgentTool.execute({}, undefined, undefined);

    expect((second as { message: string }).message).toContain("already in progress");

    vi.advanceTimersByTime(5000);
    // Only one spawn despite two calls.
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});

// ── resolveArgentBinary in isolation ──────────────────────────────────────
// Unit test the resolver directly so the contract is observable without
// going through the full tool flow.

describe("resolveArgentBinary", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-argent-binary-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the plain 'argent' name when no local devDep is on disk", async () => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
    const { resolveArgentBinary } = await import("../src/tools/system/update-argent");
    const result = resolveArgentBinary(tmpDir);
    expect(result.binary).toBe("argent");
    expect(result.spawnCwd).toBeUndefined();
  });

  it("returns the project-local binary path and cwd when node_modules/.bin/argent exists", async () => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
    const binDir = path.join(tmpDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const binName = process.platform === "win32" ? "argent.cmd" : "argent";
    fs.writeFileSync(path.join(binDir, binName), "");

    const { resolveArgentBinary } = await import("../src/tools/system/update-argent");
    const result = resolveArgentBinary(tmpDir);
    expect(result.binary).toBe(path.join(binDir, binName));
    expect(result.spawnCwd).toBe(tmpDir);
  });
});
