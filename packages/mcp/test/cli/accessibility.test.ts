import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: vi.fn() };
});

const mockedExecSync = vi.mocked(child_process.execSync);

const originalPlatform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

// ── isAccessibilityEnabled ──────────────────────────────────────────────────

describe("isAccessibilityEnabled", () => {
  let isAccessibilityEnabled: typeof import("../../src/cli/accessibility.js").isAccessibilityEnabled;

  beforeEach(async () => {
    const mod = await import("../../src/cli/accessibility.js");
    isAccessibilityEnabled = mod.isAccessibilityEnabled;
  });

  it("returns false on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(isAccessibilityEnabled()).toBe(false);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("returns false on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(isAccessibilityEnabled()).toBe(false);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("returns true when swift outputs 'true\\n'", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("true\n");
    expect(isAccessibilityEnabled()).toBe(true);
  });

  it("returns true when swift outputs 'true' without newline", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("true");
    expect(isAccessibilityEnabled()).toBe(true);
  });

  it("returns false when swift outputs 'false\\n'", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("false\n");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("returns false when swift outputs unexpected string", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("something unexpected\n");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("returns false when swift outputs empty string", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("");
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("returns false when execSync throws", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockImplementation(() => {
      throw new Error("swift not found");
    });
    expect(isAccessibilityEnabled()).toBe(false);
  });

  it("calls execSync with the correct swift command", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("false\n");
    isAccessibilityEnabled();
    expect(mockedExecSync).toHaveBeenCalledWith(
      `swift -e 'import Cocoa; print(AXIsProcessTrusted())'`,
      expect.objectContaining({
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      })
    );
  });

  it("passes timeout of 15_000 to execSync", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedExecSync.mockReturnValue("true\n");
    isAccessibilityEnabled();
    const callOptions = mockedExecSync.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(callOptions.timeout).toBe(15_000);
  });
});

// ── ensureAccessibilityPermission ───────────────────────────────────────────

describe("ensureAccessibilityPermission", () => {
  let ensureAccessibilityPermission: typeof import("../../src/cli/accessibility.js").ensureAccessibilityPermission;

  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  // Sentinel error class so we can distinguish process.exit throws
  class ProcessExitError extends Error {
    code: number;
    constructor(code: number) {
      super(`process.exit(${code})`);
      this.code = code;
    }
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    const mod = await import("../../src/cli/accessibility.js");
    ensureAccessibilityPermission = mod.ensureAccessibilityPermission;

    // Mock process.exit to throw so execution halts at call site
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as never);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function setDarwin() {
    Object.defineProperty(process, "platform", { value: "darwin" });
  }

  function mockSwiftAvailableAndAccessibility(accessibilityResults: (boolean | Error)[]) {
    let callIdx = 0;
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.startsWith("which swift")) {
        return "" as any;
      }
      if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions")) {
        return "" as any;
      }
      if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
        const result =
          accessibilityResults[callIdx] ?? accessibilityResults[accessibilityResults.length - 1];
        callIdx++;
        if (result instanceof Error) throw result;
        return result ? "true\n" : ("false\n" as any);
      }
      if (typeof cmd === "string" && cmd.startsWith("open ")) {
        return "" as any;
      }
      return "" as any;
    });
  }

  function mockSwiftUnavailable() {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
        return "false\n" as any;
      }
      if (typeof cmd === "string" && cmd.startsWith("which swift")) {
        throw new Error("not found");
      }
      return "" as any;
    });
  }

  /**
   * Run a test where ensureAccessibilityPermission is expected to eventually
   * call process.exit (which throws). This helper eagerly attaches a .catch()
   * so the rejection is never "unhandled", then advances timers, then returns
   * the caught error (or null if it resolved normally).
   */
  async function runExpectingExit(
    nonInteractive: boolean | undefined,
    advanceFn: () => Promise<void>
  ): Promise<{ error: ProcessExitError | null }> {
    let caughtError: ProcessExitError | null = null;

    const promise = ensureAccessibilityPermission(nonInteractive).catch((err) => {
      if (err instanceof ProcessExitError) {
        caughtError = err;
      } else {
        throw err;
      }
    });

    await advanceFn();
    await promise;

    return { error: caughtError };
  }

  /**
   * Run a test where ensureAccessibilityPermission is expected to resolve normally
   * (no process.exit). Advances timers via the provided function.
   */
  async function runExpectingSuccess(
    nonInteractive: boolean | undefined,
    advanceFn: () => Promise<void>
  ): Promise<void> {
    const promise = ensureAccessibilityPermission(nonInteractive);
    await advanceFn();
    await promise;
  }

  async function advanceAndFlush(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  // ── Non-darwin platforms ──────────────────────────────────────────────

  describe("on non-darwin platforms", () => {
    it("returns immediately on linux", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      mockedExecSync.mockClear();
      await ensureAccessibilityPermission();
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("returns immediately on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      mockedExecSync.mockClear();
      await ensureAccessibilityPermission();
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ── Already granted ──────────────────────────────────────────────────

  describe("when accessibility is already granted", () => {
    it("returns immediately without showing banner", async () => {
      setDarwin();
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          return "true\n" as any;
        }
        return "" as any;
      });

      await ensureAccessibilityPermission();
      expect(exitSpy).not.toHaveBeenCalled();
      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).not.toContain("ACCESSIBILITY PERMISSION REQUIRED");
    });
  });

  // ── Swift not available ──────────────────────────────────────────────

  describe("when swift is not available", () => {
    it("prints warning and exits with code 1", async () => {
      setDarwin();
      mockSwiftUnavailable();

      // process.exit throws synchronously inside the async function,
      // rejecting the returned promise immediately — no timers needed.
      const { error } = await runExpectingExit(undefined, async () => {});

      expect(error).not.toBeNull();
      expect(error!.code).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);

      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("swift");
      expect(allLogs).toContain("xcode-select --install");
    });
  });

  // ── Non-interactive mode ─────────────────────────────────────────────

  describe("non-interactive mode", () => {
    it("shows the permission-required banner", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false]);

      const { error } = await runExpectingExit(true, async () => {
        for (let i = 0; i < 6; i++) await advanceAndFlush(2000);
      });

      expect(error).not.toBeNull();
      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("ACCESSIBILITY PERMISSION REQUIRED");
    });

    it("triggers permission request via AXIsProcessTrustedWithOptions", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false, true]);

      await runExpectingSuccess(true, async () => {
        for (let i = 0; i < 6; i++) await advanceAndFlush(2000);
      });

      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      const hasPromptCall = calls.some(
        (cmd) => typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions")
      );
      expect(hasPromptCall).toBe(true);
    });

    it("exits with code 1 if denied after polling", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false]);

      const { error } = await runExpectingExit(true, async () => {
        for (let i = 0; i < 6; i++) await advanceAndFlush(2000);
      });

      expect(error).not.toBeNull();
      expect(error!.code).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("shows denied banner when permission stays denied", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false]);

      const { error } = await runExpectingExit(true, async () => {
        for (let i = 0; i < 6; i++) await advanceAndFlush(2000);
      });

      expect(error).not.toBeNull();
      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("ACCESSIBILITY PERMISSION DENIED");
    });

    it("succeeds if permission is granted during quick poll", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false, false, true]);

      await runExpectingSuccess(true, async () => {
        for (let i = 0; i < 6; i++) await advanceAndFlush(2000);
      });

      expect(exitSpy).not.toHaveBeenCalled();
      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("ACCESSIBILITY PERMISSION GRANTED");
    });

    it("does not show countdown (skips directly to prompt)", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false]);

      const { error } = await runExpectingExit(true, async () => {
        for (let i = 0; i < 6; i++) await advanceAndFlush(2000);
      });

      expect(error).not.toBeNull();
      const stdoutCalls = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      const countdownMessages = stdoutCalls.filter((s) =>
        s.includes("Opening permission prompt in")
      );
      expect(countdownMessages).toHaveLength(0);
    });
  });

  // ── Interactive mode ─────────────────────────────────────────────────

  describe("interactive mode", () => {
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
      originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    });

    /** Advance through the 3-second countdown */
    async function advanceCountdown() {
      for (let i = 0; i < 3; i++) await advanceAndFlush(1000);
    }

    it("shows the permission-required banner", async () => {
      setDarwin();
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          return callCount >= 3 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(false, async () => {
        await advanceCountdown();
        for (let i = 0; i < 4; i++) await advanceAndFlush(2000);
      });

      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("ACCESSIBILITY PERMISSION REQUIRED");
    });

    it("performs countdown writing to stdout", async () => {
      setDarwin();
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          return callCount >= 3 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(false, async () => {
        await advanceCountdown();
        for (let i = 0; i < 4; i++) await advanceAndFlush(2000);
      });

      const stdoutCalls = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      const countdownMessages = stdoutCalls.filter((s) =>
        s.includes("Opening permission prompt in")
      );
      expect(countdownMessages.length).toBeGreaterThanOrEqual(1);
    });

    it("triggers requestAccessibilityPermission after countdown", async () => {
      setDarwin();
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          return callCount >= 3 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(false, async () => {
        await advanceCountdown();
        for (let i = 0; i < 4; i++) await advanceAndFlush(2000);
      });

      const calls = mockedExecSync.mock.calls.map((c) => c[0]);
      expect(
        calls.some(
          (cmd) => typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions")
        )
      ).toBe(true);
    });

    it("displays hint about pressing s for settings", async () => {
      setDarwin();
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          return callCount >= 3 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(false, async () => {
        await advanceCountdown();
        for (let i = 0; i < 4; i++) await advanceAndFlush(2000);
      });

      const allLogs = consoleLogSpy.mock.calls
        .map((c) => (c as unknown[]).map(String).join(" "))
        .join("\n");
      expect(allLogs).toContain("Waiting for you to grant Accessibility permission");
    });

    it("succeeds when permission is granted during pollWithKeyboardHint", async () => {
      setDarwin();
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          // 1st=initial check (false), 2nd=first poll (false), 3rd=second poll (true)
          return callCount >= 3 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(false, async () => {
        await advanceCountdown();
        for (let i = 0; i < 4; i++) await advanceAndFlush(2000);
      });

      expect(exitSpy).not.toHaveBeenCalled();
      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("ACCESSIBILITY PERMISSION GRANTED");
    });

    it("shows denied banner after pollWithKeyboardHint timeout and opens settings", async () => {
      setDarwin();
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.startsWith("open ")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          // Grant on 35th check (during final waitForPermission, after denied banner)
          return callCount >= 35 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(false, async () => {
        await advanceCountdown();
        // pollWithKeyboardHint: 60s timeout, 2s interval
        for (let i = 0; i < 32; i++) await advanceAndFlush(2000);
        // final waitForPermission
        for (let i = 0; i < 40; i++) await advanceAndFlush(2000);
      });

      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("ACCESSIBILITY PERMISSION DENIED");
      expect(allLogs).toContain("Opening System Settings");

      const openCalls = mockedExecSync.mock.calls.filter(
        (c) => typeof c[0] === "string" && (c[0] as string).startsWith("open ")
      );
      expect(openCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("succeeds when permission is granted during final extended poll", async () => {
      setDarwin();
      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.startsWith("open ")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          return callCount >= 35 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(false, async () => {
        await advanceCountdown();
        for (let i = 0; i < 32; i++) await advanceAndFlush(2000);
        for (let i = 0; i < 40; i++) await advanceAndFlush(2000);
      });

      expect(exitSpy).not.toHaveBeenCalled();
      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("ACCESSIBILITY PERMISSION GRANTED");
    });

    it("calls process.exit(1) when permission denied after all attempts", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false]);

      const { error } = await runExpectingExit(false, async () => {
        await advanceCountdown();
        // pollWithKeyboardHint
        for (let i = 0; i < 32; i++) await advanceAndFlush(2000);
        // final waitForPermission
        for (let i = 0; i < 62; i++) await advanceAndFlush(2000);
      });

      expect(error).not.toBeNull();
      expect(error!.code).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("shows final abort message when permission is permanently denied", async () => {
      setDarwin();
      mockSwiftAvailableAndAccessibility([false]);

      const { error } = await runExpectingExit(false, async () => {
        await advanceCountdown();
        for (let i = 0; i < 32; i++) await advanceAndFlush(2000);
        for (let i = 0; i < 62; i++) await advanceAndFlush(2000);
      });

      expect(error).not.toBeNull();
      const allLogs = consoleLogSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(allLogs).toContain("Accessibility permission is required");
      expect(allLogs).toContain("argent init");
    });
  });

  // ── Default parameter ────────────────────────────────────────────────

  describe("default parameter", () => {
    it("defaults to interactive mode (nonInteractive = false)", async () => {
      setDarwin();

      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });

      let callCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.startsWith("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callCount++;
          return callCount >= 2 ? ("true\n" as any) : ("false\n" as any);
        }
        return "" as any;
      });

      await runExpectingSuccess(undefined, async () => {
        // countdown (proves interactive mode)
        for (let i = 0; i < 3; i++) await advanceAndFlush(1000);
        await advanceAndFlush(2000);
      });

      const stdoutCalls = stdoutWriteSpy.mock.calls.map((c) => String(c[0]));
      const hasCountdown = stdoutCalls.some((s) => s.includes("Opening permission prompt in"));
      expect(hasCountdown).toBe(true);
    });
  });
});
