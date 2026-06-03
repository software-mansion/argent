import { describe, it, expect } from "vitest";
import { TraceProcessorUnavailableError, isExecFormatError } from "../src/errors";

describe("TraceProcessorUnavailableError", () => {
  it("missing/wrong_arch messages point at the download command", () => {
    for (const kind of ["missing", "wrong_arch"] as const) {
      const err = new TraceProcessorUnavailableError(kind, {
        platform: "linux-amd64",
        version: "v55.3",
      });
      expect(err.kind).toBe(kind);
      expect(err.message).toContain("argent init --download-dependencies");
      expect(err.message).toContain("linux-amd64");
    }
  });

  it("env_path_invalid embeds the offending path and stays instanceof", () => {
    const err = new TraceProcessorUnavailableError("env_path_invalid", { path: "/bad/path" });
    expect(err.kind).toBe("env_path_invalid");
    expect(err.path).toBe("/bad/path");
    expect(err.message).toContain("/bad/path");
    expect(err).toBeInstanceOf(TraceProcessorUnavailableError);
    expect(err).toBeInstanceOf(Error);
  });

  it("unsupported_platform lists the supported platforms", () => {
    const err = new TraceProcessorUnavailableError("unsupported_platform", { platform: "win32-x64" });
    expect(err.message).toContain("mac-arm64");
    expect(err.message).toContain("linux-arm64");
  });

  it("carries the underlying cause", () => {
    const cause = new Error("boom");
    const err = new TraceProcessorUnavailableError("wrong_arch", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("isExecFormatError", () => {
  it("detects ENOEXEC by code", () => {
    expect(isExecFormatError(Object.assign(new Error("nope"), { code: "ENOEXEC" }))).toBe(true);
  });

  it("detects 'exec format error' by message", () => {
    expect(isExecFormatError(new Error("spawn ... exec format error"))).toBe(true);
  });

  it("returns false for unrelated errors and non-errors", () => {
    expect(isExecFormatError(new Error("ETIMEDOUT"))).toBe(false);
    expect(isExecFormatError(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(false);
    expect(isExecFormatError(null)).toBe(false);
    expect(isExecFormatError("exec format error")).toBe(false);
  });
});
