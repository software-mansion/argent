import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Linux-host preflight for boot-device. Two checks, both deterministic:
//
//   1. /dev/kvm usable by this user — without it qemu falls back to TCG
//      software emulation (10–50× slower).
//   2. Target AVD's hw.ramSize / vm.heapSize meet the floor the README
//      documents — undersized AVDs Watchdog-kill system_server under
//      real-world RN dev-mode load and the user sees cryptic "Activity
//      not started" / "Status: timeout" errors during the restart window.
//
// Both warnings name the exact fix. Logged at boot; never throws, never
// blocks. Returns null on non-Linux so the call site can be one-lined.
//
// We deliberately do NOT probe /proc/cpuinfo, host Vulkan ICDs, OpenGL, or
// any other env heuristic — those are flaky enough on Linux (containers,
// exotic kernels, hypervisors that hide vmx/svm) to produce false positives.
export function linuxBootDiagnostics(avdName?: string): string[] | null {
  if (process.platform !== "linux") return null;
  const diags: string[] = [];
  const kvm = checkKvm();
  if (kvm) diags.push(kvm);
  if (avdName) {
    const sizing = checkAvdSizing(avdName);
    if (sizing) diags.push(sizing);
  }
  return diags;
}

function checkKvm(): string | null {
  try {
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "/dev/kvm is missing — KVM module is not loaded or virtualization is disabled in BIOS/UEFI. The emulator will fall back to TCG software emulation (10–50× slower). Enable VT-x/AMD-V in BIOS and load the kvm module (`modprobe kvm_intel` or `modprobe kvm_amd`).";
    }
    // EACCES is the typical case: /dev/kvm is mode 660 root:kvm and the user
    // isn't in the `kvm` group. usermod is the standard fix.
    return `/dev/kvm exists but is not readable/writable by this user (code=${code ?? "unknown"}). KVM acceleration unavailable; emulator will fall back to TCG software emulation (10–50× slower). Add your user to the \`kvm\` group: \`sudo usermod -aG kvm $USER\` and re-login.`;
  }
}

const MIN_RAM_MB = 4096;
const MIN_HEAP_MB = 512;

function checkAvdSizing(avdName: string): string | null {
  // Default `avdmanager create avd` ships hw.ramSize=2G, vm.heapSize=228M —
  // enough for hello-world but not for Hermes+Metro+swiftshader. Read the
  // config we know the emulator binary will load and delegate the verdict to
  // the pure parser so the test path doesn't need fs mocking.
  const configPath = join(homedir(), ".android", "avd", `${avdName}.avd`, "config.ini");
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  return diagnoseAvdSizing(avdName, content, configPath);
}

/**
 * Pure: parse hw.ramSize / vm.heapSize out of an AVD config.ini and return a
 * single combined warning string when either is below the README floor.
 * Exported so tests can drive it without filesystem setup.
 */
export function diagnoseAvdSizing(
  avdName: string,
  configContent: string,
  configPath: string
): string | null {
  const ramMb = readMb(configContent, "hw.ramSize");
  const heapMb = readMb(configContent, "vm.heapSize");
  const issues: string[] = [];
  if (ramMb !== null && ramMb < MIN_RAM_MB) {
    issues.push(`hw.ramSize=${ramMb} MB (recommended ≥ ${MIN_RAM_MB})`);
  }
  if (heapMb !== null && heapMb < MIN_HEAP_MB) {
    issues.push(`vm.heapSize=${heapMb} MB (recommended ≥ ${MIN_HEAP_MB})`);
  }
  if (issues.length === 0) return null;
  return (
    `AVD "${avdName}" is undersized: ${issues.join(", ")}. ` +
    `Under load (Hermes JIT, Metro bundling, swiftshader rendering) Android's ` +
    `Watchdog can suicide-restart system_server, leaving the device transiently ` +
    `unresponsive. Edit ${configPath} to raise hw.ramSize to ${MIN_RAM_MB} and ` +
    `vm.heapSize to ${MIN_HEAP_MB} (see README "Linux host: extra prerequisites").`
  );
}

// Read a `key = NNNN[M|MB|G|GB]` line and normalize to MB. The emulator
// accepts both no-suffix integers (interpreted as MB) and `G` suffixes; we
// match the same convention so the recommendation matches reality.
function readMb(content: string, key: string): number | null {
  const re = new RegExp(`^\\s*${key.replace(/\./g, "\\.")}\\s*=\\s*(\\d+)\\s*([MmGg][Bb]?)?\\s*$`, "m");
  const m = content.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return (m[2] || "M").toLowerCase().startsWith("g") ? n * 1024 : n;
}
