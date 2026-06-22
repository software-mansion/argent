import { describe, it, expect } from "vitest";
import { formatErrorForAgent } from "../src/utils/format-error";

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
