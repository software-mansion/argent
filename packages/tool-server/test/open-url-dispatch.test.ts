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

  it("does not shell-wrap iOS URLs — execFile avoids the shell, so adding quotes would be wrong", async () => {
    // `simctl openurl` expects the raw URL as an argv value. If we accidentally
    // wrapped the URL in quotes like the Android branch does, iOS would receive
    // a literally-quoted URL and fail. This asserts the iOS branch sends the
    // URL verbatim — any prefix/suffix `'` would mean the quoting regressed.
    const url = "https://example.com/?q=it's";
    await openUrlTool.execute!({}, { udid: iosUdid, url });
    const args = execFileMock.mock.calls[0]![1] as string[];
    expect(args[3]).toBe(url);
    expect(args[3]!.startsWith("'")).toBe(false);
    expect(args[3]!.endsWith("'")).toBe(false);
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

describe("open-url.services", () => {
  it("never requests a service — both code paths are self-contained", () => {
    // Neither xcrun nor adb depend on a registry-managed service, so this
    // tool stays service-less. If a future change adds a service dependency,
    // update this test deliberately.
    expect(openUrlTool.services({ udid: iosUdid, url: "https://x" })).toEqual({});
    expect(openUrlTool.services({ udid: androidSerial, url: "https://x" })).toEqual({});
  });
});
