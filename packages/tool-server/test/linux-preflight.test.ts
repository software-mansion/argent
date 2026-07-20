// Unit tests for linuxBootDiagnostics. The KVM branch is small enough that
// we test the two deterministic shapes (null on non-linux, array on linux)
// and trust the try/catch from reading the code. AVD sizing is exercised
// via the pure `diagnoseAvdSizing` helper so we don't need fs mocking.

import { describe, it, expect, afterEach } from "vitest";
import { diagnoseAvdSizing, linuxBootDiagnostics } from "../src/utils/linux-preflight";

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

describe("diagnoseAvdSizing", () => {
  const PATH = "/home/test/.android/avd/argent-test.avd/config.ini";

  it("flags hw.ramSize below 4096 MB (the 2G avdmanager default)", () => {
    // 2G is the avdmanager default; covers the "fresh avdmanager AVD wedges
    // under real load" case that motivates the diagnostic. The path is
    // echoed back so the user knows exactly which file to edit.
    const out = diagnoseAvdSizing("argent-test", "hw.ramSize = 2G\nvm.heapSize = 512\n", PATH);
    expect(out).toMatch(/undersized.*hw\.ramSize=2048 MB/);
    expect(out).not.toMatch(/vm\.heapSize=/);
    expect(out).toContain(PATH);
  });

  it("flags vm.heapSize below 512 MB (the 228 avdmanager default)", () => {
    // 228 is the avdmanager default; isolates the heap-only branch so a
    // regression that conflates ram vs heap parsing surfaces here.
    const out = diagnoseAvdSizing("argent-test", "hw.ramSize = 4096\nvm.heapSize = 228M\n", PATH);
    expect(out).toMatch(/undersized.*vm\.heapSize=228 MB/);
    expect(out).not.toMatch(/hw\.ramSize=/);
  });

  it("emits a single combined warning when BOTH ram and heap are low", () => {
    const out = diagnoseAvdSizing("argent-test", "hw.ramSize = 2G\nvm.heapSize = 228M\n", PATH);
    expect(out).toMatch(/hw\.ramSize=2048 MB/);
    expect(out).toMatch(/vm\.heapSize=228 MB/);
  });

  it("returns null when both ram and heap meet the floor", () => {
    expect(
      diagnoseAvdSizing("argent-test", "hw.ramSize = 4096\nvm.heapSize = 512\n", PATH)
    ).toBeNull();
  });

  it("returns null when the keys are absent — partial configs aren't a fail signal", () => {
    // A config.ini that omits hw.ramSize / vm.heapSize means the emulator
    // will use its own defaults; we can't know the value without invoking
    // the emulator, so we stay silent rather than guess.
    expect(diagnoseAvdSizing("argent-test", "hw.cpu.ncore = 4\n", PATH)).toBeNull();
  });

  it("tolerates an inline comment after the value", () => {
    // `ini.parse` strips a trailing `# …` / `; …` comment. The previous
    // per-key `…\\s*$`-anchored regex matched the whole line and returned
    // null the moment anything followed the value, so an annotated config
    // silently lost its sizing signal.
    const out = diagnoseAvdSizing(
      "argent-test",
      "hw.ramSize = 2G # bumped from 1G\nvm.heapSize = 228M\n",
      PATH
    );
    expect(out).toMatch(/hw\.ramSize=2048 MB/);
    expect(out).toMatch(/vm\.heapSize=228 MB/);
  });
});
