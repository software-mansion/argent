import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runInstall } from "../src/install-runner.js";
import { runShellCommand, ShellCommandError } from "../src/shell.js";
import { isLocallyInstalled } from "../src/utils.js";
import type { InitTelemetry } from "../src/init-telemetry.js";

// Exercises installLocally's failure handling: the retry-once semantics, the
// don't-retry rules (missing binary, signal-terminated install), the
// locale-independent Windows missing-binary signal, and retry telemetry.

vi.mock("../src/shell.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/shell.js")>();
  return {
    ...original,
    runShellCommand: vi.fn(),
  };
});

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    resolveProjectRoot: vi.fn(() => "/fake/project"),
    hasProjectPackageJson: vi.fn(() => true),
    isDeclaredLocally: vi.fn(() => false),
    isLocallyInstalled: vi.fn(() => false),
    isYarnPnp: vi.fn(() => false),
    getLocallyInstalledVersion: vi.fn(() => "1.0.0"),
    detectProjectPackageManager: vi.fn(() => "pnpm" as const),
  };
});

// Real clack spinners animate on a TTY; stub the UI surface entirely.
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
});

vi.mock("@argent/telemetry", () => ({ track: vi.fn() }));

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

function makeTel(): InitTelemetry & { trackPackageAction: ReturnType<typeof vi.fn> } {
  return {
    installMode: "local",
    editorsConfiguredCount: 0,
    initSucceeded: false,
    trackPackageAction: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
  } as unknown as InitTelemetry & { trackPackageAction: ReturnType<typeof vi.fn> };
}

function localInstall(tel: InitTelemetry): Promise<string> {
  return runInstall({
    installMode: "local",
    fromTar: null,
    nonInteractive: true,
    version: "0.0.0",
    tel,
  });
}

describe("installLocally failure handling", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runShellCommand).mockReset();
    vi.mocked(isLocallyInstalled).mockReset();
    vi.mocked(isLocallyInstalled).mockReturnValue(false);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("retries once on a transient failure and succeeds", async () => {
    const tel = makeTel();
    vi.mocked(runShellCommand)
      .mockRejectedValueOnce(new ShellCommandError("ERR_PNPM_META_FETCH_FAIL", 1, null))
      .mockImplementationOnce(async () => {
        vi.mocked(isLocallyInstalled).mockReturnValue(true);
      });

    await expect(localInstall(tel)).resolves.toBe("1.0.0");

    expect(runShellCommand).toHaveBeenCalledTimes(2);
    expect(tel.trackPackageAction).toHaveBeenCalledWith(
      "fresh_install",
      expect.any(Number),
      true,
      undefined,
      expect.objectContaining({ retry_count: 1 })
    );
  });

  it("fails after the single retry and reports retry_count in telemetry", async () => {
    const tel = makeTel();
    vi.mocked(runShellCommand).mockRejectedValue(new ShellCommandError("registry down", 1, null));

    await expect(localInstall(tel)).rejects.toThrow(ExitCalled);

    expect(runShellCommand).toHaveBeenCalledTimes(2);
    expect(tel.trackPackageAction).toHaveBeenCalledWith(
      "fresh_install",
      expect.any(Number),
      false,
      expect.objectContaining({ error_code: expect.anything() }),
      expect.objectContaining({
        retry_count: 1,
        last_attempt_duration_ms: expect.any(Number),
      })
    );
  });

  it("does not retry when the package manager binary is missing (POSIX ENOENT)", async () => {
    const tel = makeTel();
    vi.mocked(runShellCommand).mockRejectedValue(
      Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" })
    );

    await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
    expect(runShellCommand).toHaveBeenCalledTimes(1);
  });

  it("does not retry a signal-terminated install (an interruption is not transient)", async () => {
    // A signal-delivered SIGINT/SIGTERM (CI, kill, timeout wrapper) closes the
    // child with code null; retrying would spawn a second full install after
    // the user or supervisor cancelled the first.
    const tel = makeTel();
    vi.mocked(runShellCommand).mockRejectedValue(
      new ShellCommandError("Command terminated by signal SIGINT", null, "SIGINT")
    );

    await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
    expect(runShellCommand).toHaveBeenCalledTimes(1);
    expect(tel.trackPackageAction).toHaveBeenCalledWith(
      "fresh_install",
      expect.any(Number),
      false,
      expect.anything(),
      expect.objectContaining({ retry_count: 0 })
    );
  });

  it("treats cmd.exe exit code 9009 as a missing binary on Windows (locale-independent)", async () => {
    // cmd.exe's "is not recognized" stderr is localized; 9009 is the one
    // stable signal, and runShellCommand must carry it through.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const tel = makeTel();
      vi.mocked(runShellCommand).mockRejectedValue(
        new ShellCommandError(
          '"pnpm" ist entweder falsch geschrieben oder konnte nicht gefunden werden.',
          9009,
          null
        )
      );

      await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
      expect(runShellCommand).toHaveBeenCalledTimes(1);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("retries an ordinary non-zero exit on Windows (9009 only means missing binary)", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const tel = makeTel();
      vi.mocked(runShellCommand).mockRejectedValue(
        new ShellCommandError("install failed", 1, null)
      );

      await expect(localInstall(tel)).rejects.toThrow(ExitCalled);
      expect(runShellCommand).toHaveBeenCalledTimes(2);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
