import { describe, it, expect } from "vitest";
import { simulatorRuntimeKind } from "../src/utils/ios-devices";

describe("simulatorRuntimeKind", () => {
  it.each([
    ["com.apple.CoreSimulator.SimRuntime.iOS-18-0", "mobile"],
    ["com.apple.CoreSimulator.SimRuntime.tvOS-18-0", "tv"],
    ["com.apple.CoreSimulator.SimRuntime.watchOS-11-0", undefined],
    ["com.apple.CoreSimulator.SimRuntime.xrOS-2-0", undefined],
  ])("reads %s as %s", (runtimeId, kind) => {
    expect(simulatorRuntimeKind(runtimeId)).toBe(kind);
  });
});
