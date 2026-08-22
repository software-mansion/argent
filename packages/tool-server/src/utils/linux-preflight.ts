import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseIni } from "ini";

// Boot-device preflight for Linux hosts: warnings only, never throws.
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
    // EACCES is the typical case: /dev/kvm is mode 660 root:kvm.
    return `/dev/kvm exists but is not readable/writable by this user (code=${code ?? "unknown"}). KVM acceleration unavailable; emulator will fall back to TCG software emulation (10–50× slower). Add your user to the \`kvm\` group: \`sudo usermod -aG kvm $USER\` and re-login.`;
  }
}

const MIN_RAM_MB = 4096;
const MIN_HEAP_MB = 512;

function checkAvdSizing(avdName: string): string | null {
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
 * Warn when an AVD config.ini's hw.ramSize / vm.heapSize are under the floor.
 * Exported so tests can drive it without filesystem setup.
 */
export function diagnoseAvdSizing(
  avdName: string,
  configContent: string,
  configPath: string
): string | null {
  // AVD configs have no `[section]` headers, so `ini.parse` keeps dotted keys
  // such as `hw.ramSize` literal.
  const config = parseIni(configContent);
  const ramMb = readMb(config, "hw.ramSize");
  const heapMb = readMb(config, "vm.heapSize");
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

// The emulator reads a suffix-less size as MB; match that convention.
function readMb(config: Record<string, unknown>, key: string): number | null {
  const raw = config[key];
  // `ini.parse` can yield non-strings (booleans, null), which can't be a size.
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)\s*([MmGg][Bb]?)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return (m[2] || "M").toLowerCase().startsWith("g") ? n * 1024 : n;
}
