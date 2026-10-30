import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import { track } from "@argent/telemetry";
import { runInstall } from "../src/install-runner.js";
import { runShellCommand, ShellCommandError } from "../src/shell.js";
import { isGloballyInstalled, isLocallyInstalled, resolveProjectRoot } from "../src/utils.js";
import { probeGlobalInstallTarget } from "../src/global-prefix.js";
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
    detectPackageManager: vi.fn(() => "npm" as const),
    isGloballyInstalled: vi.fn(() => false),
    getGloballyInstalledVersion: vi.fn(() => "1.0.0"),
    getLatestVersion: vi.fn(() => "2.0.0"),
  };
});

vi.mock("../src/global-prefix.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/global-prefix.js")>();
  return { ...original, probeGlobalInstallTarget: vi.fn(() => null) };
});

// Real clack spinners animate on a TTY; stub the UI surface entirely.
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    select: vi.fn(),
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

  it.skipIf(process.platform === "win32")(
    "quotes the project root in the manual-install advice",
    async () => {
      // The advice is pasted into a shell, so the path has to survive as one
      // word: `cd /a/My Project` runs `cd /a/My`.
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "argent-install-advice-"));
      const projectRoot = path.join(parent, "My 'Project' $x");
      fs.mkdirSync(projectRoot);
      try {
        vi.mocked(p.log.info).mockClear();
        vi.mocked(resolveProjectRoot).mockReturnValueOnce(projectRoot);
        vi.mocked(runShellCommand).mockRejectedValue(
          new ShellCommandError("registry down", 1, null)
        );

        await expect(localInstall(makeTel())).rejects.toThrow(ExitCalled);

        const esc = String.fromCharCode(27);
        const advice = vi
          .mocked(p.log.info)
          .mock.calls.map((c) =>
            String(c[0])
              .split(new RegExp(`${esc}\\[[0-9;]*m`, "g"))
              .join("")
          )
          .find((line) => line.startsWith("Install manually with: "));
        expect(advice).toBeDefined();

        const cd = advice!.slice(advice!.indexOf("cd ")).split(" && ")[0];
        const landed = execFileSync("/bin/sh", ["-c", `${cd} && pwd`], { encoding: "utf8" }).trim();
        expect(landed).toBe(projectRoot);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    }
  );
});

describe("global install preflight", () => {
  const storeTarget = {
    dir: "/nix/store/abc-nodejs-22/lib/node_modules",
    blocked: true,
    nixStore: true,
  };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tel: ReturnType<typeof makeTel>;

  beforeEach(() => {
    tel = makeTel();
    vi.mocked(runShellCommand).mockReset();
    vi.mocked(p.log.error).mockClear();
    vi.mocked(p.log.warn).mockClear();
    vi.mocked(p.select).mockClear();
    vi.mocked(probeGlobalInstallTarget).mockReturnValue(storeTarget);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.mocked(probeGlobalInstallTarget).mockReturnValue(null);
    vi.mocked(isGloballyInstalled).mockReturnValue(false);
  });

  function globalInstall(fromTar: string | null, nonInteractive = true): Promise<string> {
    return runInstall({ installMode: "global", fromTar, nonInteractive, version: "1.0.0", tel });
  }

  it("refuses a fresh install into a blocked directory, naming the npx remedy", async () => {
    await expect(globalInstall(null)).rejects.toThrow(new ExitCalled(1));

    expect(runShellCommand).not.toHaveBeenCalled();
    expect(String(vi.mocked(p.log.error).mock.calls[0]?.[0])).toContain(
      "npx @swmansion/argent init --local"
    );
    expect(tel.trackPackageAction).toHaveBeenCalledWith(
      "fresh_install",
      expect.any(Number),
      false,
      expect.objectContaining({ error_code: "INSTALL_GLOBAL_PREFIX_UNWRITABLE" })
    );
  });

  it("refuses a --from reinstall into a blocked directory", async () => {
    vi.mocked(isGloballyInstalled).mockReturnValue(true);

    await expect(globalInstall("/tmp/argent.tgz")).rejects.toThrow(new ExitCalled(1));

    expect(runShellCommand).not.toHaveBeenCalled();
    expect(String(vi.mocked(p.log.error).mock.calls[0]?.[0])).toContain("read-only Nix store");
  });

  it("warns instead of offering an update it cannot install", async () => {
    vi.mocked(isGloballyInstalled).mockReturnValue(true);

    await expect(globalInstall(null, false)).resolves.toBe("1.0.0");

    expect(p.select).not.toHaveBeenCalled();
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(String(vi.mocked(p.log.warn).mock.calls[0]?.[0])).toContain("cannot update");
    expect(track).toHaveBeenCalledWith("installation:update_decision", {
      from_major: 1,
      to_major: 2,
      decision: "skip",
    });
  });
});
