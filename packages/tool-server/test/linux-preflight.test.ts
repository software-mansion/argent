// Unit tests for linuxBootDiagnostics. The function is small enough that
// we test the two deterministic shapes (null on non-linux, array on linux)
// and trust the try/catch branches for ENOENT/EACCES from reading the code.

import { describe, it, expect, afterEach } from "vitest";
import { linuxBootDiagnostics } from "../src/utils/linux-preflight";

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => setPlatform(originalPlatform));

describe("linuxBootDiagnostics", () => {
  it("returns null on non-linux", () => {
    setPlatform("darwin");
    expect(linuxBootDiagnostics()).toBeNull();
  });

  it("returns an array on linux", () => {
    setPlatform("linux");
    const result = linuxBootDiagnostics();
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    // On a host where /dev/kvm is RW, the array is empty; where it isn't,
    // it contains a single string with `/dev/kvm` somewhere in it. We
    // accept either to make this test independent of the host's KVM
    // state — the actual fs branches are simple enough that reading the
    // code is more reliable than mocking node:fs in vitest.
    for (const msg of result!) {
      expect(msg).toMatch(/\/dev\/kvm/);
    }
  });
});
