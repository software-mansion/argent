// @argent/ios-profiling — an xctrace-free iOS-Simulator profiler.
//
// On Xcode 26.4+ `xctrace record --device <sim>` hangs on finalize, breaking
// Argent's native iOS profiler. This package replaces the broken capture+export
// step: a native binary drives the Instruments server over DTX
// (coreprofilesessiontap / sysmontap), and a pure-TypeScript parser turns the
// result into the same `xctrace export`-format XML that `runIosProfilerPipeline`
// consumes (`_raw_cpu.xml`, `_raw_hangs.xml`, `_raw_leaks.xml`). Everything
// downstream of that XML is unchanged. No Python, no third-party pip deps.
//
// iOS Simulator profiling is macOS-only, so every entry point guards on darwin.
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCapture } from "./parser/kdebug";
import { emitCpuAndHangs } from "./parser/emit";
import { emitLeaks } from "./leaks";

export type { AllocationProfile, LeakSummary } from "./leaks";
export { captureAllocations } from "./leaks";

const execFileAsync = promisify(execFile);

const PKG_ROOT = path.join(__dirname, "..");
const BIN_DIR = process.env.ARGENT_IOS_PROFILER_BIN_DIR ?? path.join(PKG_ROOT, "bin");

function requireDarwin(what: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `${what} requires a macOS host (iOS Simulator is unavailable on ${process.platform})`
    );
  }
}

function bin(name: string): string {
  const p = path.join(BIN_DIR, "darwin", name);
  if (!fs.existsSync(p)) {
    throw new Error(
      `ios-profiling native binary not found: ${p} (run \`npm run build:native -w @argent/ios-profiling\`)`
    );
  }
  return p;
}

/** The xctrace-export-format XML file set that `runIosProfilerPipeline` consumes. */
export interface ProfileExport {
  cpu: string;
  hangs: string;
  leaks: string;
  /** resolved target pid + name and sample/leak counts (diagnostics). */
  meta: { pid: number; name: string; cpuSamples: number; hangs: number; leaks: number };
}

export interface CaptureOptions {
  /** Booted iOS Simulator UDID. */
  udid: string;
  /** Capture window in seconds. */
  durationSec: number;
  /** Target process name or pid to scope the report to. */
  target: string | number;
  /** Path prefix for the emitted file set (`<prefix>_raw_{cpu,hangs,leaks}.xml`). */
  outPrefix: string;
}

/**
 * Capture a CPU + Hangs + Leaks profile and emit the xctrace-export XML set.
 * Drop-in replacement for `xctrace record` + `xctrace export` on Xcode 26.4+.
 */
export async function captureProfile(opts: CaptureOptions): Promise<ProfileExport> {
  requireDarwin("captureProfile");
  const rawFile = path.join(
    path.dirname(opts.outPrefix),
    `.iosprof-${process.pid}-${Date.now()}.kdbg`
  );
  try {
    // 1) native capture: drive coreprofilesessiontap → length-framed kdebug stream
    await execFileAsync(
      bin("ios-profiler-capture"),
      [opts.udid, String(opts.durationSec), rawFile],
      {
        maxBuffer: 8 * 1024 * 1024,
      }
    );
    // 2) parse (TS) → callstacks + threadmap; symbolicate (atos) → cpu + hangs XML
    const parsed = parseCapture(fs.readFileSync(rawFile));
    const emit = await emitCpuAndHangs(parsed, opts.target, opts.outPrefix);
    // 3) leaks: in-sim heap-leak engine → Leaks XML
    const leaks = await emitLeaks(opts.udid, emit.pid, `${opts.outPrefix}_raw_leaks.xml`);
    return {
      cpu: emit.cpu,
      hangs: emit.hangs,
      leaks: `${opts.outPrefix}_raw_leaks.xml`,
      meta: {
        pid: emit.pid,
        name: emit.name,
        cpuSamples: emit.cpuSamples,
        hangs: emit.hangs_count,
        leaks: leaks.leaks,
      },
    };
  } finally {
    fs.rmSync(rawFile, { force: true });
  }
}

/** A single per-process memory sample (footprint/RSS in bytes). */
export interface MemorySample {
  physFootprintBytes: number;
  residentBytes: number;
}

/** Stream per-process memory (sysmontap) for `pid` over `durationSec`. */
export async function captureMemory(
  udid: string,
  durationSec: number,
  pid: number
): Promise<MemorySample[]> {
  requireDarwin("captureMemory");
  const { stdout } = await execFileAsync(
    bin("ios-profiler-mem"),
    [udid, String(durationSec), String(pid)],
    {
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const out: MemorySample[] = [];
  for (const line of stdout.split("\n")) {
    const m = /physFootprint=([\d.]+) MB\s+resident=([\d.]+) MB/.exec(line);
    if (m)
      out.push({
        physFootprintBytes: Math.round(+m[1] * 1048576),
        residentBytes: Math.round(+m[2] * 1048576),
      });
  }
  return out;
}
