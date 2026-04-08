import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process"
  );
  return { ...actual, execSync: vi.fn() };
});

// picocolors is used in banners/output — let it pass through as identity so we
// can assert on raw text content without color codes.
vi.mock("picocolors", () => {
  const identity = (s: string) => s;
  return {
    default: new Proxy(
      {},
      {
        get: () => identity,
      }
    ),
  };
});

const mockedExecSync = vi.mocked(child_process.execSync);

// We re-import the module for each describe block that needs a fresh module
// cache so platform overrides take effect at import time.
async function freshImport() {
  return await import("../../src/cli/accessibility.js");
}

/**
 * Helper: create a standard execSync mock that routes by command string.
 * `whichSwiftResult` — return value for `which swift`, or Error to throw.
 * `accessibilityResults` — sequential return values for AXIsProcessTrusted() calls.
 */
function mockExecSyncRouted(opts: {
  whichSwift?: string | Error;
  accessibilityResults?: string[];
  openThrows?: boolean;
}) {
  let accessIdx = 0;
  const results = opts.accessibilityResults ?? ["false\n"];
  mockedExecSync.mockImplementation(((cmd: string) => {
    if (typeof cmd === "string" && cmd.includes("which swift")) {
      if (opts.whichSwift instanceof Error) throw opts.whichSwift;
      return opts.whichSwift ?? "/usr/bin/swift\n";
    }
    if (typeof cmd === "string" && cmd.startsWith("open ")) {
      if (opts.openThrows) throw new Error("open command failed");
      return "";
    }
    if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions")) {
      return "";
    }
    if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted()")) {
      const val = results[Math.min(accessIdx, results.length - 1)];
      accessIdx++;
      return val;
    }
    return "";
  }) as typeof child_process.execSync);
}

// ---------------------------------------------------------------------------
// 1. execSync edge cases for isAccessibilityEnabled
// ---------------------------------------------------------------------------
describe("isAccessibilityEnabled — execSync edge cases", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it('returns true when swift returns "true" with no trailing newline', async () => {
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("true");
    expect(isAccessibilityEnabled()).toBe(true);
  });

  it('returns false when swift returns "TRUE" (uppercase) — comparison is case-sensitive', async () => {
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("TRUE");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it('returns true when swift returns "true\\n\\n" (extra newlines) — .trim() handles it', async () => {
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("true\n\n");
    expect(isAccessibilityEnabled()).toBe(true);
  });

  it("returns false when swift returns an empty string", async () => {
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("returns false when execSync throws ETIMEDOUT", async () => {
    const { isAccessibilityEnabled } = await freshImport();
    const err = new Error("Command timed out");
    (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
    mockedExecSync.mockImplementation(() => {
      throw err;
    });
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("returns false when execSync throws ENOENT (swift not found)", async () => {
    const { isAccessibilityEnabled } = await freshImport();
    const err = new Error("spawn swift ENOENT");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    mockedExecSync.mockImplementation(() => {
      throw err;
    });
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it('returns false when swift returns "True" (capitalised) — exact match only', async () => {
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("True\n");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("returns false when swift returns whitespace-only string", async () => {
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("   \n");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it('returns true when swift returns "true" surrounded by whitespace', async () => {
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("  true  \n");
    expect(isAccessibilityEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. isSwiftAvailable — tested indirectly via ensureAccessibilityPermission
// ---------------------------------------------------------------------------
describe("isSwiftAvailable — tested via ensureAccessibilityPermission", () => {
  const originalPlatform = process.platform;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Use fake timers since ensureAccessibilityPermission may go past the
    // exit(1) mock (which doesn't actually terminate) into countdown/polling.
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as unknown as (code?: number) => never);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it('calls process.exit(1) and mentions "xcode-select --install" when swift is unavailable', async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    // isAccessibilityEnabled -> false, then isSwiftAvailable (which swift) -> throws
    // After the mocked exit(1), execution continues because the mock doesn't
    // actually exit. It falls into the banner + nonInteractive/interactive path.
    // We need to also handle the rest of the flow.
    mockExecSyncRouted({
      whichSwift: new Error("not found"),
      // After exit(1) is mocked, the function continues and calls more stuff.
      // All accessibility checks remain false.
      accessibilityResults: ["false\n"],
    });

    const promise = ensureAccessibilityPermission(false);

    // The function continues past the mocked exit(1) into the interactive flow
    // (countdown 3s + polling). Advance past all of it.
    // Countdown: 3 x 1s
    await vi.advanceTimersByTimeAsync(3000);
    // pollWithKeyboardHint: initial delay 2s + up to 60s worth of 2s polls
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    // After first poll phase fails: openAccessibilitySettings + second poll (60 attempts x 2s)
    for (let i = 0; i < 61; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    await promise;

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedOutput).toContain("xcode-select --install");
  });

  it("does not exit when swift is available but permission is already granted", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    mockExecSyncRouted({
      whichSwift: "/usr/bin/swift\n",
      accessibilityResults: ["true\n"],
    });

    await ensureAccessibilityPermission(false);

    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Platform edge cases
// ---------------------------------------------------------------------------
describe("Platform edge cases", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it.each(["linux", "win32", "freebsd", "aix"] as const)(
    "isAccessibilityEnabled returns false on %s without calling execSync",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      const { isAccessibilityEnabled } = await freshImport();
      mockedExecSync.mockClear();

      expect(isAccessibilityEnabled()).toBe(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
    }
  );

  it.each(["linux", "win32", "freebsd"] as const)(
    "ensureAccessibilityPermission returns immediately on %s — no side effects",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      const { ensureAccessibilityPermission } = await freshImport();
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => {}) as unknown as (code?: number) => never);
      mockedExecSync.mockClear();

      await ensureAccessibilityPermission(false);

      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    }
  );

  it("runs the full flow on darwin", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { isAccessibilityEnabled } = await freshImport();
    mockedExecSync.mockReturnValue("true\n");

    expect(isAccessibilityEnabled()).toBe(true);
    expect(mockedExecSync).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Non-interactive mode edge cases
// ---------------------------------------------------------------------------
describe("Non-interactive mode edge cases", () => {
  const originalPlatform = process.platform;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as unknown as (code?: number) => never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("nonInteractive=true with permission already granted — returns immediately, no banner printed", async () => {
    const { ensureAccessibilityPermission } = await freshImport();
    const consoleSpy = vi.mocked(console.log);

    mockExecSyncRouted({
      accessibilityResults: ["true\n"],
    });

    await ensureAccessibilityPermission(true);

    expect(exitSpy).not.toHaveBeenCalled();
    // No banner lines should have been printed (no ACCESSIBILITY text)
    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).not.toContain("ACCESSIBILITY PERMISSION REQUIRED");
  });

  it("nonInteractive=true with permission denied — exits(1) quickly", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    // Always denied
    mockExecSyncRouted({
      accessibilityResults: ["false\n"],
    });

    const promise = ensureAccessibilityPermission(true);

    // nonInteractive path: requestAccessibilityPermission called, then
    // waitForPermission(5, 2000). check() runs immediately (attempt 0 = false),
    // then 4 more setTimeout-based checks.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    // After nonInteractive fails, mocked process.exit(1) doesn't actually exit,
    // so execution falls through to the interactive path (countdown 3s + 2 poll phases).
    // Countdown: 3 x 1s sleep
    await vi.advanceTimersByTimeAsync(3000);
    // pollWithKeyboardHint(60): initial 2s delay + up to 30 polls
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    // Second waitForPermission(60, 2000)
    for (let i = 0; i < 61; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    await promise;

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("nonInteractive=undefined (default) — behaves as interactive (false), shows countdown", async () => {
    const { ensureAccessibilityPermission } = await freshImport();
    const writeSpy = vi.mocked(process.stdout.write);

    // Permission granted on 3rd AXIsProcessTrusted() call:
    // call 1: initial guard check -> false
    // call 2: first poll in pollWithKeyboardHint -> false
    // call 3: second poll -> true
    mockExecSyncRouted({
      accessibilityResults: ["false\n", "false\n", "true\n"],
    });

    const promise = ensureAccessibilityPermission();

    // Advance through the 3-second countdown
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    // pollWithKeyboardHint: initial delay (2s) then check, then 2s then check
    await vi.advanceTimersByTimeAsync(2000); // first poll check -> false
    await vi.advanceTimersByTimeAsync(2000); // second poll check -> true

    await promise;

    // Should have written countdown text (interactive mode indicator)
    const writtenOutput = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(writtenOutput).toContain("Opening permission prompt in");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Polling edge cases (waitForPermission behavior via nonInteractive path)
// ---------------------------------------------------------------------------
describe("Polling edge cases — waitForPermission via nonInteractive", () => {
  const originalPlatform = process.platform;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as unknown as (code?: number) => never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("permission granted on first poll check — resolves immediately without extra polls", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    // call 1: isAccessibilityEnabled guard -> false (enter flow)
    // call 2: first poll check (waitForPermission) -> true (done!)
    mockExecSyncRouted({
      accessibilityResults: ["false\n", "true\n"],
    });

    const promise = ensureAccessibilityPermission(true);

    // waitForPermission check() runs synchronously first -> finds true -> resolves
    await promise;

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("permission granted on last possible check (attempt 5 of 5) — still succeeds", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    // call 1: guard -> false
    // calls 2-5: poll checks 0-3 -> false
    // call 6: poll check 4 (last) -> true
    mockExecSyncRouted({
      accessibilityResults: [
        "false\n", // guard
        "false\n", // poll 0
        "false\n", // poll 1
        "false\n", // poll 2
        "false\n", // poll 3
        "true\n",  // poll 4 (last possible)
      ],
    });

    const promise = ensureAccessibilityPermission(true);

    // Advance through 4 intervals (check 0 is immediate, checks 1-4 need timeouts)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    await promise;

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("permission never granted — resolves false and exits after all attempts", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    // All checks return false — never granted
    mockExecSyncRouted({
      accessibilityResults: ["false\n"],
    });

    const promise = ensureAccessibilityPermission(true);

    // waitForPermission(5, 2000): check 0 immediate, then 4 x setTimeout(2000)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    // After nonInteractive exit(1) is mocked (no real exit), execution falls
    // through to the interactive path. Drain the remaining timers.
    // Countdown: 3s
    await vi.advanceTimersByTimeAsync(3000);
    // pollWithKeyboardHint(60): initial delay + polls
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    // Second waitForPermission(60, 2000)
    for (let i = 0; i < 61; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    await promise;

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Raw mode / stdin edge cases (pollWithKeyboardHint via interactive path)
// ---------------------------------------------------------------------------
describe("Raw mode / stdin edge cases", () => {
  const originalPlatform = process.platform;
  const originalIsTTY = process.stdin.isTTY;
  const originalSetRawMode = process.stdin.setRawMode;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as unknown as (code?: number) => never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    // Restore setRawMode — it may not have existed originally
    if (originalSetRawMode) {
      process.stdin.setRawMode = originalSetRawMode;
    }
  });

  it("skips raw mode setup when process.stdin.isTTY is false", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    // Install a setRawMode function so we can spy on whether it was called
    const setRawModeMock = vi.fn(() => process.stdin);
    process.stdin.setRawMode = setRawModeMock as unknown as typeof process.stdin.setRawMode;

    const { ensureAccessibilityPermission } = await freshImport();

    // guard -> false, first poll -> true
    mockExecSyncRouted({
      accessibilityResults: ["false\n", "true\n"],
    });

    const promise = ensureAccessibilityPermission(false);

    // Countdown
    await vi.advanceTimersByTimeAsync(3000);
    // First poll check (pollWithKeyboardHint initial delay)
    await vi.advanceTimersByTimeAsync(2000);

    await promise;

    expect(setRawModeMock).not.toHaveBeenCalled();
  });

  it("skips raw mode setup when process.stdin.isTTY is undefined", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    const setRawModeMock = vi.fn(() => process.stdin);
    process.stdin.setRawMode = setRawModeMock as unknown as typeof process.stdin.setRawMode;

    const { ensureAccessibilityPermission } = await freshImport();

    mockExecSyncRouted({
      accessibilityResults: ["false\n", "true\n"],
    });

    const promise = ensureAccessibilityPermission(false);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;

    expect(setRawModeMock).not.toHaveBeenCalled();
  });

  it("catches and continues when setRawMode throws", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    // Make setRawMode throw when called
    process.stdin.setRawMode = (() => {
      throw new Error("raw mode not supported");
    }) as unknown as typeof process.stdin.setRawMode;

    const { ensureAccessibilityPermission } = await freshImport();

    // guard -> false, first poll -> true
    mockExecSyncRouted({
      accessibilityResults: ["false\n", "true\n"],
    });

    const promise = ensureAccessibilityPermission(false);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    // Should not throw — raw mode error is caught
    await expect(promise).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. openAccessibilitySettings edge cases (tested indirectly)
// ---------------------------------------------------------------------------
describe("openAccessibilitySettings — failure swallowed", () => {
  const originalPlatform = process.platform;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as unknown as (code?: number) => never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("does not throw when the `open` command fails — error is swallowed", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    // Permission always denied — forces the interactive path all the way through.
    // The `open` command throws but should be caught.
    mockExecSyncRouted({
      accessibilityResults: ["false\n"],
      openThrows: true,
    });

    const promise = ensureAccessibilityPermission(false);

    // Countdown: 3s
    await vi.advanceTimersByTimeAsync(3000);

    // pollWithKeyboardHint: 60s timeout, 2s intervals.
    // Initial delay 2s, then checks. Need enough time to exhaust the timeout.
    for (let i = 0; i < 31; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    // After first poll phase: openAccessibilitySettings (throws, caught) +
    // second waitForPermission(60, 2000)
    for (let i = 0; i < 61; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    // Should complete without throwing despite `open` failing
    await expect(promise).resolves.toBeUndefined();
    // Should still exit(1) since permission was never granted
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Concurrent / timing edge cases
// ---------------------------------------------------------------------------
describe("Concurrent / timing edge cases", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.spyOn(process, "exit").mockImplementation((() => {}) as unknown as (code?: number) => never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("ensureAccessibilityPermission called when already granted — idempotent, no side effects", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    mockExecSyncRouted({
      accessibilityResults: ["true\n"],
    });

    // Call twice — both should succeed without any exit or banner
    await ensureAccessibilityPermission(false);
    await ensureAccessibilityPermission(true);

    expect(process.exit).not.toHaveBeenCalled();
  });

  it("permission changes from false to true mid-poll — detected on next check", async () => {
    const { ensureAccessibilityPermission } = await freshImport();

    // guard -> false, poll 0 -> false, poll 1 -> false, poll 2 -> true
    mockExecSyncRouted({
      accessibilityResults: ["false\n", "false\n", "false\n", "true\n"],
    });

    const promise = ensureAccessibilityPermission(true);

    // waitForPermission(5, 2000): check 0 immediate -> false
    // checks 1-2 via setTimeout
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    await promise;

    expect(process.exit).not.toHaveBeenCalled();
    const logOutput = vi.mocked(console.log).mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toContain("GRANTED");
  });
});
