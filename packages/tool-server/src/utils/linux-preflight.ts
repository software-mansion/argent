import * as fs from "node:fs";

/**
 * Linux-host preflight for `boot-device` (Android emulator).
 *
 * `linuxBootDiagnostics()` checks for the two host conditions that silently
 * kneecap AVD performance with an unambiguous fix: KVM device accessibility
 * and CPU virtualization extensions. `bootAndroid` logs the warnings once
 * per boot so a user about to wait for a TCG-emulated AVD sees *why* and
 * what to fix, instead of attributing the 10–50× slowdown to argent.
 *
 * Returns `null` on non-Linux hosts so the call site can be one-lined.
 * Pure-fs/sync (no spawning) so it's cheap to call on every boot.
 *
 * Deliberately narrow: argent's Linux GPU choice (`-gpu swiftshader` —
 * see `boot-device.ts:selectGpuMode`) doesn't depend on host Vulkan or
 * OpenGL, so we don't probe those. The Linux-emulator-perf advice that
 * IS argent-relevant lives in the README.
 */

export interface LinuxBootDiagnostic {
  /** `warning` is degraded-but-bootable; `info` is purely informational. */
  severity: "warning" | "info";
  message: string;
}

/**
 * Run the Linux-only host checks and return a list of diagnostics worth
 * surfacing to the user. Returns `null` on non-Linux hosts so the call site
 * can be one-lined.
 *
 * No fatal severity: we never block a boot from preflight — KVM-less hosts
 * still boot, just very slowly, and a developer who knowingly works on a
 * VPS without nested virt has the right to that pain. We only inform.
 */
export function linuxBootDiagnostics(): LinuxBootDiagnostic[] | null {
  if (process.platform !== "linux") return null;
  const diags: LinuxBootDiagnostic[] = [];

  // 1) KVM device accessible to this process. Without it qemu falls back to
  //    TCG full-software emulation which is 10–50× slower than KVM. The mode
  //    bits matter — `/dev/kvm` is typically 660 root:kvm, and a user not in
  //    the `kvm` group hits EACCES on open. We don't enforce membership, just
  //    explain the symptom and the standard fix.
  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      diags.push({
        severity: "warning",
        message:
          "/dev/kvm is missing — KVM module is not loaded or virtualization is disabled in BIOS/UEFI. The emulator will fall back to TCG software emulation (10–50× slower). Enable VT-x/AMD-V in BIOS and load the kvm module (`modprobe kvm_intel` or `modprobe kvm_amd`).",
      });
    } else {
      diags.push({
        severity: "warning",
        message:
          "/dev/kvm exists but is not readable/writable by this user (code=" +
          (code ?? "unknown") +
          "). KVM acceleration unavailable; emulator will fall back to TCG software emulation (10–50× slower). Add your user to the `kvm` group: `sudo usermod -aG kvm $USER` and re-login.",
      });
    }
  }

  // 2) CPU virt extensions. Already implied by /dev/kvm working, but a host
  //    that's *itself* a VM with nested virt disabled has the file present and
  //    yet boots without acceleration. Flag the cpuinfo case as a separate
  //    signal because the fix is different (enable nested virt on the parent
  //    hypervisor, not the guest).
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    if (!/^flags\s*:[^\n]*\b(vmx|svm)\b/m.test(cpuinfo)) {
      diags.push({
        severity: "warning",
        message:
          "CPU `flags` line in /proc/cpuinfo lists no `vmx` (Intel) or `svm` (AMD) — hardware virtualization extensions are unavailable to this kernel. If you're inside a VM, enable nested virtualization on the host hypervisor. Without virt extensions, the emulator runs in TCG software mode (very slow).",
      });
    }
  } catch {
    // /proc/cpuinfo unreadable is exotic enough that we'd rather not noise.
  }

  return diags;
}
