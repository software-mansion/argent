import { describe, it, expect } from "vitest";
import { formatErrorForAgent, subprocessOutputTail } from "../src/utils/format-error";

describe("formatErrorForAgent", () => {
  it("returns the message for a plain error", () => {
    expect(formatErrorForAgent(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-errors", () => {
    expect(formatErrorForAgent("not an error")).toBe("not an error");
  });

  it("appends unique root-cause details", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    const err = new Error("fetch failed", { cause });
    expect(formatErrorForAgent(err)).toBe(
      "fetch failed — caused by: connect ECONNREFUSED 127.0.0.1:8080"
    );
  });

  it("skips a cause whose text is already present", () => {
    const cause = new Error("fetch failed");
    const err = new Error("fetch failed", { cause });
    expect(formatErrorForAgent(err)).toBe("fetch failed");
  });

  it("terminates on a cyclic cause chain instead of hanging", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(formatErrorForAgent(a)).toBe("a — caused by: b");
  });
});

describe("subprocessOutputTail", () => {
  it("keeps the last few non-empty lines of stderr", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "\n  ERROR: could not install  \n\n  The device is locked.  \n\n",
      stdout: "",
    });
    expect(subprocessOutputTail(err)).toBe("ERROR: could not install | The device is locked.");
  });

  it("never lets stdout progress chatter displace the stderr diagnosis", () => {
    // `devicectl` narrates on stdout and reports on stderr, and the callers do
    // not pass `--quiet`. Sharing one last-N window between the two streams
    // means four lines of narration erase the one line that says what failed.
    const err = Object.assign(new Error("Command failed"), {
      stderr:
        "ERROR: The operation couldn't be completed. Unable to install the app.\n" +
        "  Underlying error: The device is locked.\n" +
        "  Recovery suggestion: Unlock the device and try again.\n",
      stdout: [
        "12:00:01  Acquired tunnel connection to device.",
        "12:00:01  Enabling developer disk image services.",
        "12:00:02  Acquired usage assertion.",
        "12:00:03  Transferring app bundle...",
      ].join("\n"),
    });
    const tail = subprocessOutputTail(err);
    expect(tail).toMatch(/device is locked/i);
    expect(tail).toMatch(/Unlock the device/i);
    expect(tail).not.toMatch(/Transferring app bundle/);
  });

  it("falls back to stdout when stderr said nothing", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "   \n\n",
      stdout: "no such application\n",
    });
    expect(subprocessOutputTail(err)).toBe("no such application");
  });

  it("keeps at most the last four lines", () => {
    const err = Object.assign(new Error("x"), {
      stderr: Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n"),
    });
    expect(subprocessOutputTail(err)).toBe("line36 | line37 | line38 | line39");
  });

  it("bounds the result, because the message goes into an agent's context", () => {
    // A crash loop can emit unbounded output on a single line, which the
    // last-four-lines trim alone does not cap.
    const err = Object.assign(new Error("x"), { stderr: "y".repeat(50_000) });
    const tail = subprocessOutputTail(err);
    expect(tail.length).toBeLessThanOrEqual(401);
    expect(tail.startsWith("…")).toBe(true);
  });

  it("answers empty for anything that carries no readable output, without throwing", () => {
    // The callers append it only when non-empty, so every one of these degrades
    // to the message they had before rather than to "undefined" or a crash —
    // and a rejection is not always an Error with string stdio.
    for (const value of [
      undefined,
      null,
      "a string rejection",
      new Error("no stdio"),
      Object.assign(new Error("x"), { stderr: 42 }),
      Object.assign(new Error("x"), { stderr: Buffer.from("bytes") }),
    ]) {
      expect(subprocessOutputTail(value)).toBe("");
    }
  });
});
