/**
 * Unit tests for the Linux-only host preflight helpers in
 * `packages/tool-server/src/utils/linux-preflight.ts`. The helpers are pure
 * filesystem reads + platform checks, so we mock `node:fs` and override
 * `process.platform` to exercise both the linux and non-linux code paths.
 *
 * Contract pinned by these tests: on non-linux hosts, every helper returns
 * the empty/null sentinel without touching the filesystem — so a darwin (or
 * future windows) build never spuriously prints linux-specific warnings.
 * On linux, each diagnostic branch (KVM ENOENT, KVM EACCES, missing virt
 * flags, no ICDs, software-only ICDs, fully-healthy) is reachable and
 * produces the user-facing remediation messages we care about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  accessSync: vi.fn(),
  readFileSync: vi.fn(),
  constants: { R_OK: 4, W_OK: 2 },
}));

vi.mock("node:fs", () => fsMock);

// Imports must come AFTER the mock declaration so the module under test
// picks up the mocked fs. vitest hoists vi.mock() above all imports per its
// docs, but explicit ordering here is defensive against future refactors.
import { detectHostVulkanIcds, linuxBootDiagnostics } from "../src/utils/linux-preflight";

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  fsMock.readdirSync.mockReset();
  fsMock.accessSync.mockReset();
  fsMock.readFileSync.mockReset();
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe("linux-preflight — non-linux short-circuit", () => {
  it("detectHostVulkanIcds returns empty on darwin without touching fs", () => {
    setPlatform("darwin");
    expect(detectHostVulkanIcds()).toEqual({ icds: [], hasHardwareIcd: false });
    expect(fsMock.readdirSync).not.toHaveBeenCalled();
  });

  it("linuxBootDiagnostics returns null on darwin", () => {
    setPlatform("darwin");
    expect(linuxBootDiagnostics()).toBeNull();
    expect(fsMock.readdirSync).not.toHaveBeenCalled();
  });
});

describe("detectHostVulkanIcds (linux)", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  it("returns empty when no ICD dirs exist", () => {
    fsMock.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const r = detectHostVulkanIcds();
    expect(r.icds).toEqual([]);
    expect(r.hasHardwareIcd).toBe(false);
  });

  it("flags only software ICDs as non-hardware", () => {
    fsMock.readdirSync.mockImplementation((dir: string) => {
      if (dir === "/usr/share/vulkan/icd.d") {
        return ["lvp_icd.json", "vk_swiftshader_icd.json"];
      }
      return [];
    });
    const r = detectHostVulkanIcds();
    expect(r.icds.length).toBe(2);
    expect(r.hasHardwareIcd).toBe(false);
  });

  it("treats intel/nvidia/radeon ICDs as hardware", () => {
    fsMock.readdirSync.mockImplementation((dir: string) => {
      if (dir === "/usr/share/vulkan/icd.d") {
        return ["intel_icd.json", "nvidia_icd.json", "lvp_icd.json"];
      }
      return [];
    });
    const r = detectHostVulkanIcds();
    expect(r.icds.length).toBe(3);
    expect(r.hasHardwareIcd).toBe(true);
  });
});

describe("linuxBootDiagnostics (linux)", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  it("warns when /dev/kvm is missing entirely (ENOENT)", () => {
    fsMock.accessSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    fsMock.readFileSync.mockReturnValue("flags : vmx other\n");
    fsMock.readdirSync.mockReturnValue(["intel_icd.json"]);

    const diags = linuxBootDiagnostics()!;
    expect(diags.some((d) => /\/dev\/kvm is missing/.test(d.message))).toBe(true);
  });

  it("warns when /dev/kvm exists but is not RW (EACCES → group hint)", () => {
    fsMock.accessSync.mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    fsMock.readFileSync.mockReturnValue("flags : vmx other\n");
    fsMock.readdirSync.mockReturnValue(["intel_icd.json"]);

    const diags = linuxBootDiagnostics()!;
    const kvmDiag = diags.find((d) => /kvm/i.test(d.message))!;
    expect(kvmDiag).toBeTruthy();
    expect(kvmDiag.message).toMatch(/usermod -aG kvm/);
  });

  it("warns when CPU flags lack vmx/svm", () => {
    fsMock.accessSync.mockReturnValue(undefined);
    fsMock.readFileSync.mockReturnValue("flags : sse4_2 avx\n");
    fsMock.readdirSync.mockReturnValue(["intel_icd.json"]);

    const diags = linuxBootDiagnostics()!;
    expect(diags.some((d) => /vmx.*svm|virtualization extensions/.test(d.message))).toBe(true);
  });

  it("warns when ICD dir is empty (no Vulkan at all)", () => {
    fsMock.accessSync.mockReturnValue(undefined);
    fsMock.readFileSync.mockReturnValue("flags : vmx\n");
    fsMock.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const diags = linuxBootDiagnostics()!;
    expect(diags.some((d) => /No Vulkan ICDs found/.test(d.message))).toBe(true);
  });

  it("warns when only software ICDs are present", () => {
    fsMock.accessSync.mockReturnValue(undefined);
    fsMock.readFileSync.mockReturnValue("flags : vmx\n");
    fsMock.readdirSync.mockImplementation((dir: string) => {
      if (dir === "/usr/share/vulkan/icd.d") return ["lvp_icd.json", "vk_swiftshader_icd.json"];
      return [];
    });

    const diags = linuxBootDiagnostics()!;
    expect(diags.some((d) => /Only software Vulkan/.test(d.message))).toBe(true);
  });

  it("returns no diagnostics when KVM + virt + hardware Vulkan all present", () => {
    fsMock.accessSync.mockReturnValue(undefined);
    fsMock.readFileSync.mockReturnValue("flags : vmx avx\n");
    fsMock.readdirSync.mockImplementation((dir: string) => {
      if (dir === "/usr/share/vulkan/icd.d") return ["intel_icd.json"];
      return [];
    });

    const diags = linuxBootDiagnostics()!;
    expect(diags).toEqual([]);
  });
});
