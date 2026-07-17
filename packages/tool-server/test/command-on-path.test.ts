import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock execFile with the repo's standard idiom: the callback receives a single
// `{ stdout, stderr }` value (so `promisify(execFile)` resolves to that object),
// or an Error to model a non-zero exit (command not found).
const execFileMock = vi.fn();
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
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { commandOnPath } from "../src/utils/command-on-path";

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("commandOnPath", () => {
  beforeEach(() => execFileMock.mockReset());
  afterEach(() => {
    setPlatform(realPlatform);
    vi.restoreAllMocks();
  });

  it("uses `command -v` via /bin/sh on POSIX and returns the trimmed path", async () => {
    setPlatform("darwin");
    execFileMock.mockReturnValue({ stdout: "/usr/bin/adb\n", stderr: "" });
    const result = await commandOnPath("adb");
    expect(result).toBe("/usr/bin/adb");
    expect(execFileMock).toHaveBeenCalledWith("/bin/sh", ["-c", "command -v adb"]);
  });

  it("uses `where` on Windows and returns the first matching line", async () => {
    setPlatform("win32");
    // `where` prints one path per match, CRLF-terminated; the first wins.
    execFileMock.mockReturnValue({
      stdout: "C:\\Android\\platform-tools\\adb.exe\r\nC:\\other\\adb.bat\r\n",
      stderr: "",
    });
    const result = await commandOnPath("adb");
    expect(result).toBe("C:\\Android\\platform-tools\\adb.exe");
    expect(execFileMock).toHaveBeenCalledWith("where", ["adb"]);
  });

  it("returns null when the command is not on PATH (non-zero exit)", async () => {
    setPlatform("darwin");
    execFileMock.mockReturnValue(new Error("not found"));
    expect(await commandOnPath("nope")).toBeNull();
  });

  it("returns null on Windows when `where` finds nothing", async () => {
    setPlatform("win32");
    execFileMock.mockReturnValue(new Error("INFO: Could not find files"));
    expect(await commandOnPath("nope")).toBeNull();
  });

  it("returns null when the resolver emits only blank lines", async () => {
    setPlatform("win32");
    execFileMock.mockReturnValue({ stdout: "\r\n  \r\n", stderr: "" });
    expect(await commandOnPath("adb")).toBeNull();
  });

  it("skips a CWD match (`where` searches CWD before PATH) and takes the PATH one", async () => {
    setPlatform("win32");
    vi.spyOn(process, "cwd").mockReturnValue("C:\\work\\repo");
    // `where adb` lists the planted CWD copy first, the real SDK adb second.
    execFileMock.mockReturnValue({
      stdout: "C:\\work\\repo\\adb.exe\r\nC:\\Android\\platform-tools\\adb.exe\r\n",
      stderr: "",
    });
    expect(await commandOnPath("adb")).toBe("C:\\Android\\platform-tools\\adb.exe");
  });

  it("matches the CWD case-insensitively when skipping it", async () => {
    setPlatform("win32");
    vi.spyOn(process, "cwd").mockReturnValue("C:\\Work\\Repo");
    execFileMock.mockReturnValue({
      stdout: "c:\\work\\repo\\adb.exe\r\nC:\\Android\\platform-tools\\adb.exe\r\n",
      stderr: "",
    });
    expect(await commandOnPath("adb")).toBe("C:\\Android\\platform-tools\\adb.exe");
  });

  it("returns null when the only match is the CWD-planted binary", async () => {
    setPlatform("win32");
    vi.spyOn(process, "cwd").mockReturnValue("C:\\work\\repo");
    execFileMock.mockReturnValue({ stdout: "C:\\work\\repo\\adb.exe\r\n", stderr: "" });
    expect(await commandOnPath("adb")).toBeNull();
  });
});
