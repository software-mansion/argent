/**
 * Unit tests for the Linux-only host preflight in
 * `packages/tool-server/src/utils/linux-preflight.ts`. The helper is pure
 * filesystem reads + a platform check, so we mock `node:fs` and override
 * `process.platform` to exercise both the linux and non-linux code paths.
 *
 * Each diagnostic branch (KVM ENOENT, KVM EACCES, missing virt flags,
 * fully-healthy) is reachable and produces the user-facing remediation
 * message we care about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fsMock = vi.hoisted(() => ({
  accessSync: vi.fn(),
  readFileSync: vi.fn(),
  constants: { R_OK: 4, W_OK: 2 },
}));

vi.mock("node:fs", () => fsMock);

import { linuxBootDiagnostics } from "../src/utils/linux-preflight";

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  fsMock.accessSync.mockReset();
  fsMock.readFileSync.mockReset();
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("linuxBootDiagnostics", () => {
  it("returns null on darwin without touching fs", () => {
    setPlatform("darwin");
    expect(linuxBootDiagnostics()).toBeNull();
    expect(fsMock.accessSync).not.toHaveBeenCalled();
  });

  describe("on linux", () => {
    beforeEach(() => setPlatform("linux"));

    it("warns when /dev/kvm is missing (ENOENT)", () => {
      fsMock.accessSync.mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      fsMock.readFileSync.mockReturnValue("flags : vmx\n");

      const diags = linuxBootDiagnostics()!;
      expect(diags.some((d) => /\/dev\/kvm is missing/.test(d.message))).toBe(true);
    });

    it("warns when /dev/kvm exists but is not RW (EACCES → group hint)", () => {
      fsMock.accessSync.mockImplementation(() => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      });
      fsMock.readFileSync.mockReturnValue("flags : vmx\n");

      const diags = linuxBootDiagnostics()!;
      const kvmDiag = diags.find((d) => /kvm/i.test(d.message))!;
      expect(kvmDiag).toBeTruthy();
      expect(kvmDiag.message).toMatch(/usermod -aG kvm/);
    });

    it("warns when CPU flags lack vmx/svm", () => {
      fsMock.accessSync.mockReturnValue(undefined);
      fsMock.readFileSync.mockReturnValue("flags : sse4_2 avx\n");

      const diags = linuxBootDiagnostics()!;
      expect(diags.some((d) => /vmx.*svm|virtualization extensions/.test(d.message))).toBe(true);
    });

    it("returns no diagnostics on a healthy host (KVM RW + vmx)", () => {
      fsMock.accessSync.mockReturnValue(undefined);
      fsMock.readFileSync.mockReturnValue("flags : vmx avx\n");

      const diags = linuxBootDiagnostics()!;
      expect(diags).toEqual([]);
    });
  });
});
