import { describe, it, expect, vi, beforeEach } from "vitest";

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
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { openUrlTool } from "../src/tools/simulator/open-url";

const iosUdid = "11111111-2222-3333-4444-555555555555";
const androidSerial = "emulator-5554";

beforeEach(() => {
  execFileMock.mockReset().mockReturnValue({ stdout: "", stderr: "" });
});

describe("open-url — iOS path (unchanged)", () => {
  it("calls `xcrun simctl openurl` with the URL verbatim, no shell escaping", async () => {
    await openUrlTool.execute!({}, { udid: iosUdid, url: "https://example.com" });
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "openurl", iosUdid, "https://example.com"],
      undefined
    );
  });

  it("passes app schemes through untouched", async () => {
    await openUrlTool.execute!({}, { udid: iosUdid, url: "messages://" });
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "openurl", iosUdid, "messages://"],
      undefined
    );
  });
});

describe("open-url — Android path", () => {
  it("routes through `am start -a VIEW -d <url>` via adb shell", async () => {
    await openUrlTool.execute!({}, { udid: androidSerial, url: "https://example.com" });
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        androidSerial,
        "shell",
        "am start -a android.intent.action.VIEW -d 'https://example.com'",
      ],
      expect.any(Object)
    );
  });

  it("shell-escapes single quotes in the URL", async () => {
    // adb shell interprets the argument as a single shell string, so any
    // embedded `'` must be escaped as `'\''`. If this regresses, URLs with
    // apostrophes will crash `am start` with a syntax error.
    await openUrlTool.execute!(
      {},
      { udid: androidSerial, url: "https://example.com/path/it's-here" }
    );
    const call = execFileMock.mock.calls[0]![1] as string[];
    const shellCommand = call[3]!;
    expect(shellCommand.includes(`'\\''`)).toBe(true);
    expect(shellCommand).toBe(
      `am start -a android.intent.action.VIEW -d 'https://example.com/path/it'\\''s-here'`
    );
  });

  it("throws when `am start` surfaces an error for an unhandled scheme", async () => {
    execFileMock.mockReturnValue({
      stdout: "Error: Activity not started, unable to resolve Intent",
      stderr: "",
    });
    await expect(
      openUrlTool.execute!({}, { udid: androidSerial, url: "custom-scheme://unknown" })
    ).rejects.toThrow(/open-url failed/);
  });

  it("rejects `No Activity found` output", async () => {
    execFileMock.mockReturnValue({
      stdout: "No Activity found to handle Intent { VIEW dat=... }",
      stderr: "",
    });
    await expect(
      openUrlTool.execute!({}, { udid: androidSerial, url: "custom-scheme://x" })
    ).rejects.toThrow(/open-url failed/);
  });
});

