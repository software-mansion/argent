import { describe, expect, it } from "vitest";
import { assertHermesCpuProfile } from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";

/**
 * `assertHermesCpuProfile` is the unified shape guard for every consumer of
 * an on-disk Hermes CPU profile. Without it, a malformed profile (most often
 * produced when react-profiler-start ran against a release build and the
 * Hermes sampler never actually started) used to surface deep in the
 * pipeline as `Cannot read properties of undefined (reading 'length')`.
 * These tests pin the verbose, actionable messages we emit instead.
 */

const VALID_PROFILE = {
  samples: [1, 2, 3],
  nodes: [{ id: 1 }],
  timeDeltas: [10, 10, 10],
  startTime: 1000,
  endTime: 2000,
};

describe("assertHermesCpuProfile", () => {
  it("accepts a well-formed profile", () => {
    expect(() => assertHermesCpuProfile(VALID_PROFILE, "test")).not.toThrow();
  });

  it("throws verbose error when profile is null", () => {
    expect(() => assertHermesCpuProfile(null, "test")).toThrow(/CPU profile is missing/i);
    expect(() => assertHermesCpuProfile(null, "test")).toThrow(/dev(elopment)? build/i);
  });

  it("throws verbose error when profile is not an object", () => {
    expect(() => assertHermesCpuProfile("not-an-object", "test")).toThrow(
      /CPU profile is missing/i
    );
  });

  it("throws verbose malformed-profile error when samples is missing", () => {
    const broken = { ...VALID_PROFILE, samples: undefined };
    expect(() => assertHermesCpuProfile(broken, "ctx")).toThrow(
      /missing samples\/nodes\/timeDeltas/i
    );
    expect(() => assertHermesCpuProfile(broken, "ctx")).toThrow(/release build/i);
    expect(() => assertHermesCpuProfile(broken, "ctx")).toThrow(/React DevTools/i);
  });

  it("throws verbose malformed-profile error when nodes is missing", () => {
    const broken = { ...VALID_PROFILE, nodes: undefined };
    expect(() => assertHermesCpuProfile(broken, "ctx")).toThrow(
      /missing samples\/nodes\/timeDeltas/i
    );
  });

  it("throws verbose malformed-profile error when timeDeltas is missing", () => {
    const broken = { ...VALID_PROFILE, timeDeltas: undefined };
    expect(() => assertHermesCpuProfile(broken, "ctx")).toThrow(
      /missing samples\/nodes\/timeDeltas/i
    );
  });

  it("throws verbose error when startTime/endTime are missing", () => {
    const broken = { ...VALID_PROFILE, startTime: undefined };
    expect(() => assertHermesCpuProfile(broken, "ctx")).toThrow(/startTime\/endTime/i);
  });

  it("includes the calling context in the error so operators know which tool failed", () => {
    expect(() => assertHermesCpuProfile(null, "react-profiler-analyze")).toThrow(
      /react-profiler-analyze/
    );
  });
});
