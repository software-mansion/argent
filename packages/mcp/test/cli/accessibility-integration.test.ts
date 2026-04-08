import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execSync: vi.fn() };
});

const mockedExecSync = vi.mocked(child_process.execSync);

/**
 * Helper: start an async function that may throw via process.exit, advance
 * fake timers, and collect the result. We attach the catch handler *before*
 * any timers fire so the rejection is never truly unhandled.
 */
async function driveToCompletion(
  fn: () => Promise<void>,
  timerSteps: Array<{ ms: number; count: number }>
): Promise<{ exitCalled: boolean }> {
  let exitCalled = false;
  const promise = fn().catch((err: any) => {
    if (err?.message === "process.exit") {
      exitCalled = true;
    } else {
      throw err;
    }
  });

  for (const step of timerSteps) {
    for (let i = 0; i < step.count; i++) {
      await vi.advanceTimersByTimeAsync(step.ms);
    }
  }

  await promise;
  return { exitCalled };
}

describe("accessibility integration", () => {
  const originalPlatform = process.platform;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error("process.exit");
      }) as (code?: number) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function allConsoleOutput(): string {
    return consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  function mockAlwaysDenied(): void {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("which swift")) return "" as any;
      if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
        return "" as any;
      if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted"))
        return "false\n" as any;
      return "" as any;
    });
  }

  // ── 1. Init integration ──────────────────────────────────────────────────

  describe("init integration", () => {
    it("ensureAccessibilityPermission is importable and callable", async () => {
      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );
      expect(typeof ensureAccessibilityPermission).toBe("function");
    });

    it("accepts a nonInteractive boolean parameter", async () => {
      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );
      Object.defineProperty(process, "platform", { value: "linux" });
      await expect(ensureAccessibilityPermission(true)).resolves.toBeUndefined();
      await expect(ensureAccessibilityPermission(false)).resolves.toBeUndefined();
    });

    it("on non-darwin, init flow proceeds without interruption", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );
      await ensureAccessibilityPermission(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("when accessibility is already granted, init flow proceeds without interruption", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted"))
          return "true\n" as any;
        return "" as any;
      });

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );
      await ensureAccessibilityPermission(false);
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  // ── 2. Permission denial flow (non-interactive) ──────────────────────────

  describe("permission denial flow (non-interactive)", () => {
    it("prints banner, requests permission, prints denied banner, and exits", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockAlwaysDenied();

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );

      const { exitCalled } = await driveToCompletion(
        () => ensureAccessibilityPermission(true),
        [{ ms: 2000, count: 6 }]
      );

      const output = allConsoleOutput();

      expect(output).toContain("ACCESSIBILITY PERMISSION REQUIRED");

      const execCalls = mockedExecSync.mock.calls.map((c) => String(c[0]));
      expect(execCalls.some((c) => c.includes("AXIsProcessTrustedWithOptions"))).toBe(
        true
      );

      expect(exitCalled).toBe(true);
      expect(processExitSpy).toHaveBeenCalledWith(1);

      expect(output).toContain("ACCESSIBILITY PERMISSION DENIED");
    });
  });

  // ── 3. Permission grant flow (non-interactive) ───────────────────────────

  describe("permission grant flow (non-interactive)", () => {
    it("prints success banner when permission is granted during polling", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      let axCallCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          axCallCount++;
          return (axCallCount >= 3 ? "true\n" : "false\n") as any;
        }
        return "" as any;
      });

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );

      const { exitCalled } = await driveToCompletion(
        () => ensureAccessibilityPermission(true),
        [{ ms: 2000, count: 5 }]
      );

      expect(allConsoleOutput()).toContain("ACCESSIBILITY PERMISSION GRANTED");
      expect(exitCalled).toBe(false);
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  // ── 4. Banner content verification ───────────────────────────────────────

  describe("banner content verification", () => {
    it("warning banner contains required key text", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockAlwaysDenied();

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );

      await driveToCompletion(
        () => ensureAccessibilityPermission(true),
        [{ ms: 2000, count: 6 }]
      );

      const output = allConsoleOutput();
      expect(output).toContain("ACCESSIBILITY PERMISSION REQUIRED");
      expect(output).toContain("describe");
      expect(output).toContain("Allow");
    });

    it("success banner contains required key text", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      let axCallCount = 0;
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("which swift")) return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions"))
          return "" as any;
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          axCallCount++;
          return (axCallCount >= 2 ? "true\n" : "false\n") as any;
        }
        return "" as any;
      });

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );

      await driveToCompletion(
        () => ensureAccessibilityPermission(true),
        [{ ms: 2000, count: 5 }]
      );

      const output = allConsoleOutput();
      expect(output).toContain("ACCESSIBILITY PERMISSION GRANTED");
      expect(output).toContain("Thank you");
    });

    it("denied banner contains required key text", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      mockAlwaysDenied();

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );

      await driveToCompletion(
        () => ensureAccessibilityPermission(true),
        [{ ms: 2000, count: 6 }]
      );

      const output = allConsoleOutput();
      expect(output).toContain("ACCESSIBILITY PERMISSION DENIED");
      expect(output).toContain("System Settings");
      expect(output).toContain("Privacy & Security");
      expect(output).toContain("argent init");
    });
  });

  // ── 5. Sequential flow verification ──────────────────────────────────────

  describe("sequential flow verification", () => {
    it("execSync calls follow correct order: swift check -> AXIsProcessTrustedWithOptions -> polling", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      const callOrder: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("which swift")) {
          callOrder.push("which-swift");
          return "" as any;
        }
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions")) {
          callOrder.push("request-permission");
          return "" as any;
        }
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          callOrder.push("check-accessibility");
          return "false\n" as any;
        }
        return "" as any;
      });

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );

      await driveToCompletion(
        () => ensureAccessibilityPermission(true),
        [{ ms: 2000, count: 6 }]
      );

      // isAccessibilityEnabled() is called first as the initial guard
      expect(callOrder[0]).toBe("check-accessibility");
      // Then isSwiftAvailable via "which swift"
      expect(callOrder[1]).toBe("which-swift");
      // Then requestAccessibilityPermission
      expect(callOrder[2]).toBe("request-permission");
      // Remaining calls are polling accessibility checks
      const pollingChecks = callOrder.slice(3);
      expect(pollingChecks.length).toBeGreaterThan(0);
      expect(pollingChecks.every((c) => c === "check-accessibility")).toBe(true);
    });

    it("in interactive mode, countdown happens before permission request", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      const events: string[] = [];
      mockedExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("which swift")) {
          events.push("which-swift");
          return "" as any;
        }
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrustedWithOptions")) {
          events.push("request-permission");
          return "" as any;
        }
        if (typeof cmd === "string" && cmd.includes("AXIsProcessTrusted")) {
          events.push("check-ax");
          return "false\n" as any;
        }
        if (typeof cmd === "string" && cmd.includes("x-apple.systempreferences")) {
          events.push("open-settings");
          return "" as any;
        }
        return "" as any;
      });

      stdoutWriteSpy.mockImplementation((data: any) => {
        if (typeof data === "string" && data.includes("Opening permission prompt in")) {
          events.push("countdown");
        }
        return true;
      });

      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

      const { ensureAccessibilityPermission } = await import(
        "../../src/cli/accessibility.js"
      );

      await driveToCompletion(
        () => ensureAccessibilityPermission(false),
        [
          // Countdown: 3 x 1s sleep
          { ms: 1000, count: 3 },
          // pollWithKeyboardHint: 60s timeout, 2s intervals
          { ms: 2000, count: 35 },
          // waitForPermission second phase: 60 attempts * 2s
          { ms: 2000, count: 65 },
        ]
      );

      Object.defineProperty(process.stdin, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });

      const countdownIdx = events.indexOf("countdown");
      const requestIdx = events.indexOf("request-permission");
      expect(countdownIdx).toBeGreaterThanOrEqual(0);
      expect(requestIdx).toBeGreaterThan(countdownIdx);
    });
  });
});
