import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PS_ARGS_WITH_PID, PS_BIN } from "./vega-process";

const execFileAsync = promisify(execFile);

/**
 * Running Android emulators from the OS process table, by AVD. adb cannot name
 * the AVD of an emulator that is shutting down or still coming up (getprop fails
 * and the console does not answer), but the process keeps its `-avd <name>`
 * argument until it exits.
 */

// The qemu binary the `emulator` launcher execs into
// (`…/qemu/darwin-aarch64/qemu-system-aarch64`), or the launcher itself on
// builds where it stays the parent. Anchored to a path boundary and a following
// argument so a process that merely mentions such a path does not count.
const EMULATOR_PROCESS_RE = /(?:^|\/)(?:qemu-system-[\w-]+|emulator|emulator64-[\w-]+)\s/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * PIDs of the emulator processes running `avdName`, from `ps -o pid=,command=`
 * output. `-avd <name>` has to match as a whole argument: `Pixel_7` must not
 * match an emulator running `Pixel_7_API_34`.
 */
export function parseEmulatorPidsForAvd(psOutput: string, avdName: string): number[] {
  const avdArg = new RegExp(`(?:^|\\s)-avd\\s+${escapeRegExp(avdName)}(?:\\s|$)`);
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const argv = m[2]!;
    if (!EMULATOR_PROCESS_RE.test(argv) || !avdArg.test(argv)) continue;
    pids.push(parseInt(m[1]!, 10));
  }
  return pids;
}

/**
 * PIDs of the emulator processes running `avdName` (empty if none, or if `ps`
 * is unavailable, as on Windows).
 */
export async function listEmulatorPidsForAvd(avdName: string): Promise<number[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync(PS_BIN, [...PS_ARGS_WITH_PID], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseEmulatorPidsForAvd(stdout, avdName);
  } catch (err) {
    process.stderr.write(
      `[emulator-process] ps probe failed; assuming no emulator runs "${avdName}": ${String(err)}\n`
    );
    return [];
  }
}
