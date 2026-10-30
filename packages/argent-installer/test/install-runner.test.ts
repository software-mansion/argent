import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import { runInstall } from "../src/install-runner.js";
import { runShellCommand, ShellCommandError } from "../src/shell.js";
import {
  detectProjectPackageManager,
  getLatestVersion,
  isGloballyInstalled,
  isLocallyInstalled,
  resolveProjectRoot,
} from "../src/utils.js";
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
    isGloballyInstalled: vi.fn(() => false),
    getGloballyInstalledVersion: vi.fn(() => "1.0.0"),
    getLatestVersion: vi.fn(() => "1.0.0"),
  };
});

// Real clack spinners animate on a TTY; stub the UI surface entirely.
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...actual,
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    select: vi.fn(),
  };
});

vi.mock("@argent/telemetry", () => ({ track: vi.fn() }));

// A successful global update re-syncs the real skills store via `npx skills`.
vi.mock("../src/skills.js", () => ({ reportSkillRefresh: vi.fn() }));

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

describe("install under Yarn 2+", () => {
  const savedAgent = process.env.npm_config_user_agent;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(runShellCommand).mockReset();
    vi.mocked(p.log.info).mockClear();
    process.env.npm_config_user_agent = "yarn/4.13.0 npm/? node/v24.14.1 darwin arm64";
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (savedAgent === undefined) delete process.env.npm_config_user_agent;
    else process.env.npm_config_user_agent = savedAgent;
  });

  it("installs with npm and advises the npm command on failure", async () => {
    vi.mocked(runShellCommand).mockRejectedValue(new ShellCommandError("registry down", 1, null));

    await expect(
      runInstall({
        installMode: "global",
        fromTar: null,
        nonInteractive: true,
        version: "0.0.0",
        tel: makeTel(),
      })
    ).rejects.toThrow(ExitCalled);

    expect(runShellCommand).toHaveBeenCalledWith({
      bin: "npm",
      args: ["install", "-g", "@swmansion/argent"],
    });
    const esc = String.fromCharCode(27);
    const advice = vi
      .mocked(p.log.info)
      .mock.calls.map((c) =>
        String(c[0])
          .split(new RegExp(`${esc}\\[[0-9;]*m`, "g"))
          .join("")
      )
      .find((line) => line.startsWith("Install Argent manually with: "));
    expect(advice).toBe("Install Argent manually with: npm install -g @swmansion/argent");
  });

  it("reinstalls from a tarball with npm", async () => {
    vi.mocked(isGloballyInstalled).mockReturnValueOnce(true);
    vi.mocked(runShellCommand).mockResolvedValue(undefined);

    await runInstall({
      installMode: "global",
      fromTar: "/tmp/argent.tgz",
      nonInteractive: true,
      version: "0.0.0",
      tel: makeTel(),
    });

    expect(runShellCommand).toHaveBeenCalledWith({
      bin: "npm",
      args: ["install", "-g", "/tmp/argent.tgz"],
    });
  });

  it("updates an outdated global install with npm", async () => {
    vi.mocked(isGloballyInstalled).mockReturnValueOnce(true);
    vi.mocked(getLatestVersion).mockReturnValueOnce("99.0.0");
    vi.mocked(p.select).mockResolvedValueOnce("update");
    vi.mocked(runShellCommand).mockResolvedValue(undefined);

    await runInstall({
      installMode: "global",
      fromTar: null,
      nonInteractive: false,
      version: "0.0.0",
      tel: makeTel(),
    });

    expect(runShellCommand).toHaveBeenCalledWith({
      bin: "npm",
      args: ["install", "-g", "@swmansion/argent@99.0.0"],
    });
  });

  it("adds a local devDependency with the project's yarn", async () => {
    vi.mocked(detectProjectPackageManager).mockReturnValueOnce("yarn");
    vi.mocked(isLocallyInstalled).mockReturnValue(false);
    vi.mocked(runShellCommand).mockImplementationOnce(async () => {
      vi.mocked(isLocallyInstalled).mockReturnValue(true);
    });

    await localInstall(makeTel());

    expect(runShellCommand).toHaveBeenCalledWith(
      { bin: "yarn", args: ["add", "--dev", "@swmansion/argent"] },
      { cwd: "/fake/project" }
    );
  });
});
