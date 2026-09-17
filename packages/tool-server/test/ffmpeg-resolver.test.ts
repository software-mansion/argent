import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Issue #621: a `--disable-gpl` ffmpeg on PATH (conda-forge ships one) has no
 * libx264, so every recording dies with `Unrecognized option 'preset'` while a
 * perfectly good build sits unreachable in the fallback list.
 *
 * The trap these tests exist to keep shut: ffmpeg reports the missing encoder in
 * its OUTPUT and exits 0 either way, so a probe written as
 * `try { await execFileAsync(...) } catch { next }` looks like a fix and changes
 * nothing.
 */

const execFileMock = vi.fn();

// The variant that attaches stdout/stderr to the rejection (as execFile really
// does) — without it the "answered correctly, then exited non-zero" case cannot
// be expressed at all.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const result = execFileMock(cmd, args);
      if (result instanceof Error) {
        const e = result as Error & { stdout?: string; stderr?: string };
        callback(e, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
      } else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

const commandOnPathMock = vi.fn(async (_name: string): Promise<string | null> => null);
vi.mock("../src/utils/command-on-path", () => ({
  commandOnPath: (name: string) => commandOnPathMock(name),
}));

// Pinned so a real /opt/homebrew/bin/ffmpeg on the developer's machine cannot
// leak into a result.
const executablePaths = new Set<string>();
const realpathMap = new Map<string, string>();
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (p: string) => {
      if (!executablePaths.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    realpath: async (p: string) => realpathMap.get(p) ?? p,
  };
});

import {
  resolveFfmpeg,
  ffmpegUnavailableMessage,
} from "../src/tools/screen-recording/ffmpeg-binary";

const CONDA = "/opt/miniconda3/bin/ffmpeg";
const BREW = "/opt/homebrew/bin/ffmpeg";
const USR_LOCAL = "/usr/local/bin/ffmpeg";

/** What a build WITH libx264 prints (stdout), verbatim from ffmpeg 7.1.1. */
const SUPPORTED_OUT = {
  stdout:
    "Encoder libx264 [libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10]:\n    General capabilities: dr1 delay threads\n",
  stderr: "",
};
/** What a --disable-gpl build prints — note it EXITS 0. */
const UNSUPPORTED_OUT = {
  stdout: "Codec 'libx264' is not recognized by FFmpeg.\n",
  stderr: "",
};

function spawnError(code: string): Error {
  return Object.assign(new Error(`spawn ${code}`), { code, stdout: "", stderr: "" });
}

let savedOverride: string | undefined;

beforeEach(() => {
  execFileMock.mockReset();
  commandOnPathMock.mockReset();
  commandOnPathMock.mockResolvedValue(null);
  executablePaths.clear();
  realpathMap.clear();
  savedOverride = process.env.ARGENT_FFMPEG;
  delete process.env.ARGENT_FFMPEG;
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env.ARGENT_FFMPEG;
  else process.env.ARGENT_FFMPEG = savedOverride;
});

describe("resolveFfmpeg — capability, not just presence", () => {
  it("uses the PATH ffmpeg when it can encode, probing exactly once", async () => {
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    await expect(resolveFfmpeg()).resolves.toEqual({ ok: true, path: BREW, origin: "path" });
    // Pins the short-circuit: a healthy host pays one exec, not four.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("skips a PATH ffmpeg that lacks libx264 and reaches the fallback", async () => {
    // The reported host, exactly: conda first on PATH, Homebrew in the fallbacks.
    commandOnPathMock.mockResolvedValue(CONDA);
    executablePaths.add(BREW);
    execFileMock.mockImplementation((cmd: string) =>
      cmd === BREW ? SUPPORTED_OUT : UNSUPPORTED_OUT
    );

    await expect(resolveFfmpeg()).resolves.toEqual({ ok: true, path: BREW, origin: "fallback" });
  });

  it("never consults the exit status — a good build that exits non-zero still wins", async () => {
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(
      Object.assign(new Error("Command failed"), {
        code: 3, // NUMBER: a non-zero exit, not a spawn failure
        stdout: SUPPORTED_OUT.stdout,
        stderr: "",
      })
    );

    await expect(resolveFfmpeg()).resolves.toMatchObject({ ok: true, path: BREW });
  });

  it("reads stderr as well as stdout", async () => {
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue({ stdout: "", stderr: SUPPORTED_OUT.stdout });

    await expect(resolveFfmpeg()).resolves.toMatchObject({ ok: true, path: BREW });
  });

  it("probes with the exact argv, so nobody quietly changes the question", async () => {
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    await resolveFfmpeg();

    // -hide_banner is load-bearing: without it ffmpeg writes its build banner to
    // stderr, and that banner contains the literal `--enable-libx264`.
    expect(execFileMock).toHaveBeenCalledWith(BREW, ["-hide_banner", "-h", "encoder=libx264"]);
  });
});

describe("resolveFfmpeg — an inconclusive answer must never break a working host", () => {
  it("uses a candidate whose probe timed out", async () => {
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(
      Object.assign(new Error("timeout"), {
        killed: true,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
      })
    );

    await expect(resolveFfmpeg()).resolves.toEqual({ ok: true, path: BREW, origin: "path" });
  });

  it("treats a killed probe as inconclusive even when it printed something first", async () => {
    // Partial output from a run that never finished is not evidence of absence.
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(
      Object.assign(new Error("timeout"), {
        killed: true,
        signal: "SIGTERM",
        stdout: "Codec 'libx26",
        stderr: "",
      })
    );

    await expect(resolveFfmpeg()).resolves.toMatchObject({ ok: true, path: BREW });
  });

  it("still prefers a candidate that positively supports libx264", async () => {
    commandOnPathMock.mockResolvedValue(CONDA);
    executablePaths.add(BREW);
    execFileMock.mockImplementation((cmd: string) =>
      cmd === BREW
        ? SUPPORTED_OUT
        : Object.assign(new Error("timeout"), { killed: true, stdout: "", stderr: "" })
    );

    await expect(resolveFfmpeg()).resolves.toMatchObject({ ok: true, path: BREW });
  });
});

describe("resolveFfmpeg — candidate collection", () => {
  it("probes one binary once when PATH and the fallback are the same file", async () => {
    commandOnPathMock.mockResolvedValue(BREW);
    executablePaths.add(BREW);
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    await resolveFfmpeg();

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("dedups two prefixes that symlink to the same binary", async () => {
    // The Intel-mac shape: /usr/local/bin/ffmpeg -> the Homebrew Cellar binary.
    const cellar = "/opt/homebrew/Cellar/ffmpeg/7.1.1_3/bin/ffmpeg";
    commandOnPathMock.mockResolvedValue(USR_LOCAL);
    executablePaths.add(BREW);
    realpathMap.set(USR_LOCAL, cellar);
    realpathMap.set(BREW, cellar);
    execFileMock.mockReturnValue(UNSUPPORTED_OUT);

    const result = await resolveFfmpeg();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    // And the path reported back is the one the user recognises, not the Cellar
    // realpath — a wrapper at that prefix must not be bypassed either.
    expect(result).toEqual({
      ok: false,
      reason: "unusable",
      override: null,
      tried: [USR_LOCAL],
    });
  });

  it("reports 'missing' — and probes nothing — when there is no ffmpeg at all", async () => {
    const result = await resolveFfmpeg();

    expect(result).toEqual({ ok: false, reason: "missing", override: null, tried: [] });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not count a vanished binary as one that was tried and rejected", async () => {
    // Deleted between the executable check and the exec.
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(spawnError("ENOENT"));

    await expect(resolveFfmpeg()).resolves.toEqual({
      ok: false,
      reason: "missing",
      override: null,
      tried: [],
    });
  });

  it("does not tell a user with an unrunnable ffmpeg that ffmpeg is missing", async () => {
    // EACCES means the file is right there. "Install it" would be nonsense.
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(spawnError("EACCES"));

    await expect(resolveFfmpeg()).resolves.toEqual({
      ok: false,
      reason: "unusable",
      override: null,
      tried: [BREW],
    });
  });

  it("does not cache, so installing ffmpeg mid-session recovers", async () => {
    // The tool-server has no idle shutdown by default; a sticky negative would
    // outlive the user following the advice in our own error message.
    const first = await resolveFfmpeg();
    expect(first.ok).toBe(false);

    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    await expect(resolveFfmpeg()).resolves.toMatchObject({ ok: true, path: BREW });
  });
});

describe("ARGENT_FFMPEG — the escape hatch must actually escape", () => {
  it("wins over PATH without consulting it", async () => {
    process.env.ARGENT_FFMPEG = "/opt/custom/ffmpeg";
    executablePaths.add("/opt/custom/ffmpeg");
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    await expect(resolveFfmpeg()).resolves.toEqual({
      ok: true,
      path: "/opt/custom/ffmpeg",
      origin: "override",
    });
    expect(commandOnPathMock).not.toHaveBeenCalled();
  });

  it("is honoured even when the probe does not recognise the build", async () => {
    // THE POINT OF THE OVERRIDE. The probe's one new failure mode is a false
    // negative on a build whose help output we don't recognise; if the override
    // were subject to the probe, the user it exists to rescue would have no way
    // out. Worst case they get ffmpeg's own error — what they got before.
    process.env.ARGENT_FFMPEG = "/opt/custom/ffmpeg";
    executablePaths.add("/opt/custom/ffmpeg");
    execFileMock.mockReturnValue({ stdout: "some fork's unfamiliar help text\n", stderr: "" });

    await expect(resolveFfmpeg()).resolves.toEqual({
      ok: true,
      path: "/opt/custom/ffmpeg",
      origin: "override",
    });
  });

  it("never silently falls through to PATH", async () => {
    // An override that is quietly ignored is its own bug: the user pinned a
    // binary and must be told it is wrong, not handed a different one.
    process.env.ARGENT_FFMPEG = "/opt/custom/ffmpeg";
    commandOnPathMock.mockResolvedValue(BREW);
    executablePaths.add(BREW);
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    const result = await resolveFfmpeg();

    expect(result).toEqual({
      ok: false,
      reason: "missing",
      override: "/opt/custom/ffmpeg",
      tried: [],
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("resolves a bare command name through PATH lookup", async () => {
    process.env.ARGENT_FFMPEG = "ffmpeg7";
    commandOnPathMock.mockResolvedValue("/usr/bin/ffmpeg7");
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    await expect(resolveFfmpeg()).resolves.toMatchObject({
      ok: true,
      path: "/usr/bin/ffmpeg7",
      origin: "override",
    });
    expect(commandOnPathMock).toHaveBeenCalledWith("ffmpeg7");
  });

  it("ignores a blank value rather than failing on it", async () => {
    process.env.ARGENT_FFMPEG = "   ";
    commandOnPathMock.mockResolvedValue(BREW);
    execFileMock.mockReturnValue(SUPPORTED_OUT);

    await expect(resolveFfmpeg()).resolves.toMatchObject({ origin: "path" });
  });
});

describe("ffmpegUnavailableMessage", () => {
  it("does not say 'not found' to someone who has ffmpeg installed", async () => {
    const msg = ffmpegUnavailableMessage({
      ok: false,
      reason: "unusable",
      override: null,
      tried: [CONDA, BREW],
    });

    expect(msg).not.toMatch(/not found/i);
    expect(msg).toContain(CONDA);
    expect(msg).toContain(BREW);
    expect(msg).toContain("libx264");
    // The false-negative victim reads THIS message, so it has to name the way out.
    expect(msg).toContain("ARGENT_FFMPEG");
  });

  it("still tells someone with no ffmpeg how to install it", async () => {
    const msg = ffmpegUnavailableMessage({
      ok: false,
      reason: "missing",
      override: null,
      tried: [],
    });

    expect(msg).toMatch(/not found/i);
    expect(msg).toContain("brew install ffmpeg");
  });

  it("names the override when the override is the problem", async () => {
    const missing = ffmpegUnavailableMessage({
      ok: false,
      reason: "missing",
      override: "/opt/custom/ffmpeg",
      tried: [],
    });
    expect(missing).toContain("ARGENT_FFMPEG");
    expect(missing).toContain("/opt/custom/ffmpeg");

    const unusable = ffmpegUnavailableMessage({
      ok: false,
      reason: "unusable",
      override: "/opt/custom/ffmpeg",
      tried: ["/opt/custom/ffmpeg"],
    });
    expect(unusable).toContain("ARGENT_FFMPEG");
  });
});
