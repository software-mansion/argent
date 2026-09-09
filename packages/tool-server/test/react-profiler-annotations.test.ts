import { describe, it, expect } from "vitest";
import {
  resolveAnnotations,
  reactProfilerAnalyzeTool,
} from "../src/tools/profiler/react/react-profiler-analyze";
import { FailureError, FAILURE_CODES, getFailureSignal } from "@argent/registry";

// The anchor react-profiler-start recorded with the session.
const START = 1_700_000_000_000;

function parseAnnotations(annotations: unknown) {
  const schema = reactProfilerAnalyzeTool.zodSchema;
  if (!schema) throw new Error("react-profiler-analyze declares no zodSchema");
  return schema.safeParse({
    device_id: "sim",
    project_root: "/tmp/app",
    annotations,
  });
}

describe("react-profiler-analyze annotations", () => {
  it("turns a gesture's own timestampMs into an offset from the profiling start", () => {
    expect(
      resolveAnnotations([{ timestampMs: START + 4200, label: "tap Settings" }], START)
    ).toEqual([{ offsetMs: 4200, label: "tap Settings" }]);
  });

  it("passes a caller-computed offsetMs through untouched", () => {
    expect(resolveAnnotations([{ offsetMs: 4200, label: "tap Settings" }], START)).toEqual([
      { offsetMs: 4200, label: "tap Settings" },
    ]);
  });

  it("resolves each annotation against the same anchor", () => {
    expect(
      resolveAnnotations(
        [
          { timestampMs: START + 1000, label: "tap" },
          { timestampMs: START + 2500, label: "swipe back" },
        ],
        START
      )
    ).toEqual([
      { offsetMs: 1000, label: "tap" },
      { offsetMs: 2500, label: "swipe back" },
    ]);
  });

  it("leaves undefined annotations undefined", () => {
    expect(resolveAnnotations(undefined, START)).toBeUndefined();
  });

  // A session stored before the anchor was written, or one whose commits file
  // is absent: silently placing the action at offset 0 would put every
  // annotation on the first commit and read as real data.
  it("fails loudly when a timestamp has no anchor to measure against", () => {
    expect(() => resolveAnnotations([{ timestampMs: START + 10, label: "tap" }], null)).toThrow(
      FailureError
    );
    try {
      resolveAnnotations([{ timestampMs: START + 10, label: "tap" }], null);
      expect.unreachable("an unanchored timestamp must not resolve");
    } catch (e) {
      expect((e as Error).message).toMatch(/timestampMs/);
      // Not the NO_DATA code: the session data loaded fine, the annotation is
      // what could not be placed.
      expect(getFailureSignal(e)?.error_code).toBe(
        FAILURE_CODES.REACT_PROFILER_ANALYZE_ANNOTATION_UNANCHORED
      );
    }
  });

  it("still accepts a pure-offset annotation with no anchor", () => {
    expect(resolveAnnotations([{ offsetMs: 10, label: "tap" }], null)).toEqual([
      { offsetMs: 10, label: "tap" },
    ]);
  });

  it("accepts either form on its own", () => {
    expect(parseAnnotations([{ timestampMs: START, label: "a" }]).success).toBe(true);
    expect(parseAnnotations([{ offsetMs: 5, label: "a" }]).success).toBe(true);
  });

  // Both would be a contradiction the tool would have to silently resolve.
  it("rejects an annotation carrying both forms, or neither", () => {
    expect(parseAnnotations([{ timestampMs: START, offsetMs: 5, label: "a" }]).success).toBe(false);
    expect(parseAnnotations([{ label: "a" }]).success).toBe(false);
  });
});
