import * as fs from "node:fs";

// Linux-host preflight for boot-device. We check exactly one thing: is /dev/kvm
// usable by this user? If not, qemu falls back to TCG software emulation which
// is 10–50× slower. Logged as a warning at boot time so the user knows what to
// fix; never throws, never blocks a boot. Returns null on non-Linux so the
// call site can be one-lined.
//
// We deliberately do NOT probe /proc/cpuinfo, host Vulkan ICDs, OpenGL, or any
// other env heuristic — those are flaky enough on Linux (containers, exotic
// kernels, hypervisors that hide vmx/svm) to produce false positives, and the
// /dev/kvm check alone covers ~all real cases of "why is my AVD slow".
export function linuxBootDiagnostics(): string[] | null {
  if (process.platform !== "linux") return null;
  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
    return [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [
        "/dev/kvm is missing — KVM module is not loaded or virtualization is disabled in BIOS/UEFI. The emulator will fall back to TCG software emulation (10–50× slower). Enable VT-x/AMD-V in BIOS and load the kvm module (`modprobe kvm_intel` or `modprobe kvm_amd`).",
      ];
    }
    // EACCES is the typical case: /dev/kvm is mode 660 root:kvm and the user
    // isn't in the `kvm` group. usermod is the standard fix.
    return [
      `/dev/kvm exists but is not readable/writable by this user (code=${code ?? "unknown"}). KVM acceleration unavailable; emulator will fall back to TCG software emulation (10–50× slower). Add your user to the \`kvm\` group: \`sudo usermod -aG kvm $USER\` and re-login.`,
    ];
  }
}
