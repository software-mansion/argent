import * as fs from "node:fs";

/**
 * Linux-host preflight for `boot-device` (Android emulator). Returns the
 * warnings worth surfacing on a Linux host that silently kneecap AVD
 * performance, each with an unambiguous fix:
 *
 *   - `/dev/kvm` not present or not RW → emulator falls back to TCG
 *     full-software emulation (10–50× slower than KVM).
 *   - CPU `flags` line lacks `vmx`/`svm` → same TCG fallback, but the
 *     fix is different (enable nested virt on the parent hypervisor).
 *
 * Returns `null` on non-Linux hosts so the call site can be one-lined.
 * Never throws; never blocks a boot — KVM-less hosts still boot, just
 * very slowly.
 *
 * Scope note: argent's Linux GPU choice (`-gpu swiftshader` — see
 * `boot-device.ts:selectGpuMode`) doesn't depend on host Vulkan or
 * OpenGL, so we don't probe those.
 */
export function linuxBootDiagnostics(): string[] | null {
  if (process.platform !== "linux") return null;
  const diags: string[] = [];

  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      diags.push(
        "/dev/kvm is missing — KVM module is not loaded or virtualization is disabled in BIOS/UEFI. The emulator will fall back to TCG software emulation (10–50× slower). Enable VT-x/AMD-V in BIOS and load the kvm module (`modprobe kvm_intel` or `modprobe kvm_amd`)."
      );
    } else {
      // EACCES is the typical case: /dev/kvm is mode 660 root:kvm and the
      // user isn't in the `kvm` group. usermod is the standard fix.
      diags.push(
        `/dev/kvm exists but is not readable/writable by this user (code=${code ?? "unknown"}). KVM acceleration unavailable; emulator will fall back to TCG software emulation (10–50× slower). Add your user to the \`kvm\` group: \`sudo usermod -aG kvm $USER\` and re-login.`
      );
    }
  }

  // /dev/kvm working implies vmx/svm, but a host that's *itself* a VM with
  // nested virt disabled passes the kvm check and still boots in TCG — the
  // fix is different (enable nested virt on the parent hypervisor), so a
  // separate signal is worth the extra branch.
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    if (!/^flags\s*:[^\n]*\b(vmx|svm)\b/m.test(cpuinfo)) {
      diags.push(
        "CPU `flags` line in /proc/cpuinfo lists no `vmx` (Intel) or `svm` (AMD) — hardware virtualization extensions are unavailable to this kernel. If you're inside a VM, enable nested virtualization on the host hypervisor. Without virt extensions, the emulator runs in TCG software mode (very slow)."
      );
    }
  } catch {
    // /proc/cpuinfo unreadable is exotic enough that we'd rather not noise.
  }

  return diags;
}
