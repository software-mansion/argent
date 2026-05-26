import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Linux-host preflight helpers for `boot-device` (Android emulator).
 *
 * `linuxBootDiagnostics()` runs the host-side checks (KVM, CPU virt flags,
 * Vulkan ICDs) and returns a list of human-friendly warnings — or `null` on
 * non-Linux hosts so the call site can be one-lined. `bootAndroid` logs these
 * once per boot so a user who's about to wait for a software-emulated AVD
 * knows *why* and what to fix, instead of attributing the slowness to argent.
 *
 * The dominant source of "Linux emulator is slow" complaints is the bundled
 * Vulkan loader under `$ANDROID_HOME/emulator/lib64/vulkan/` only seeing the
 * software-only `lvp_icd.json` (lavapipe) and `vk_swiftshader_icd.json`. The
 * emulator's `-gpu auto` heuristic resolves to `hw.gpu.mode=lavapipe` against
 * that bundled loader even on hosts with hardware Vulkan installed, because
 * the loader never looks at the system ICD path. `boot-device` works around
 * this on Linux by passing `-gpu host` (OpenGL passthrough via host libGL),
 * which sidesteps the bundled Vulkan stack entirely — see
 * `boot-device.ts:selectGpuMode`. The Vulkan diagnostic in this file is kept
 * because (a) it surfaces broader GPU-stack health, and (b) the AVD's
 * standalone guest GPU emulation still benefits from a healthy host Vulkan
 * driver outside argent's launch path. macOS gets hardware acceleration for
 * free via MoltenVK/Metal, which is why this problem is Linux-specific.
 *
 * Helpers are pure-fs/sync (no spawning) so they're cheap to call on every
 * boot. The ICD list is read fresh each call rather than cached — a user who
 * installs a missing driver mid-session sees the warning disappear on the
 * next boot without a tool-server restart.
 */

const SYSTEM_VULKAN_ICD_DIRS = [
  // Standard FHS location populated by mesa/vulkan-* packages on every major
  // distro (Arch, Debian, Ubuntu, Fedora). Searched first because it's where
  // distro packages drop their ICDs.
  "/usr/share/vulkan/icd.d",
  // Sysadmin-overlay path honored by the Vulkan loader for site-wide ICDs that
  // can't or shouldn't live under /usr (per the Vulkan loader spec).
  "/etc/vulkan/icd.d",
  // The NVIDIA proprietary driver installer drops icd.json files under
  // /usr/share alongside the distro-managed ones; nothing extra to probe here.
];

// Substrings (lower-cased) we treat as software-only Vulkan ICDs. The host
// having only these is functionally equivalent to having no ICD at all for
// our purposes — the emulator's own bundled stack offers the same fallback,
// and pointing it at the system loader doesn't accelerate anything.
const SOFTWARE_VULKAN_ICDS = ["lvp", "lavapipe", "swrast", "swiftshader"];

export interface LinuxVulkanInfo {
  /** Absolute paths of every `*_icd.json` we found across system ICD dirs. */
  icds: string[];
  /** True if at least one ICD looks like a hardware backend (intel/nvidia/radeon/…). */
  hasHardwareIcd: boolean;
}

/**
 * Enumerate the host's Vulkan ICDs. Cheap (a couple readdirs) so callers can
 * invoke per boot without caching. Returns `{ icds: [], hasHardwareIcd: false
 * }` on non-Linux hosts so callers don't need a platform guard.
 */
export function detectHostVulkanIcds(): LinuxVulkanInfo {
  if (process.platform !== "linux") {
    return { icds: [], hasHardwareIcd: false };
  }
  const icds: string[] = [];
  for (const dir of SYSTEM_VULKAN_ICD_DIRS) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // Dir absent or unreadable — skip silently, the loader's behavior here.
      continue;
    }
    for (const name of entries) {
      // The Vulkan loader spec accepts any `*.json` in icd.d/, but every
      // real ICD file shipped by every distro follows the `<vendor>_icd.json`
      // convention. Tighten to that so a stray `package.json` or a stale
      // `<vendor>_icd.json.dpkg-dist` doesn't get classified as an ICD.
      if (!name.endsWith("_icd.json")) continue;
      icds.push(path.join(dir, name));
    }
  }
  const hasHardwareIcd = icds.some((p) => {
    const base = path.basename(p).toLowerCase();
    return !SOFTWARE_VULKAN_ICDS.some((sw) => base.includes(sw));
  });
  return { icds, hasHardwareIcd };
}

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

  // 3) Vulkan ICDs. Informational: argent passes `-gpu host` on Linux, which
  //    routes the emulator at the host's libGL instead of the bundled Vulkan
  //    loader — so a Linux user without hardware Vulkan ICDs still gets a
  //    hardware-accelerated boot as long as their GL stack is healthy. We
  //    still surface this warning because (a) it correlates with broader
  //    GPU-driver health, and (b) the emulator's other rendering paths
  //    (snapshot composition, certain ANGLE shaders) can still fall back to
  //    Vulkan internally. The fix is package-installation, so the message
  //    names the typical packages per ecosystem.
  const { icds, hasHardwareIcd } = detectHostVulkanIcds();
  if (icds.length === 0) {
    diags.push({
      severity: "warning",
      message:
        "No Vulkan ICDs found under /usr/share/vulkan/icd.d or /etc/vulkan/icd.d. The emulator will use its bundled lavapipe (software) renderer — every guest frame is rasterized on the host CPU. Install the Vulkan driver for your GPU: `vulkan-intel` / `vulkan-radeon` / `nvidia-utils` on Arch; `mesa-vulkan-drivers` on Debian/Ubuntu; `mesa-vulkan-drivers` or `nvidia-driver-*` on Fedora.",
    });
  } else if (!hasHardwareIcd) {
    diags.push({
      severity: "warning",
      message:
        "Only software Vulkan ICDs detected (" +
        icds.map((p) => path.basename(p)).join(", ") +
        "). The emulator's `-gpu auto` will render every guest frame on the host CPU. Install a hardware Vulkan driver: `vulkan-intel` / `vulkan-radeon` / `nvidia-utils` on Arch; `mesa-vulkan-drivers` on Debian/Ubuntu.",
    });
  }

  return diags;
}
