import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseVvdConsolePorts,
  parseVvdPids,
  listRunningVvdConsolePorts,
  listRunningVvdPids,
  PS_ARGS,
  PS_ARGS_WITH_PID,
} from "../src/utils/vega-process";

const execFileAsync = promisify(execFile);

// A `ps` line for a running VVD: the `vega-virtual-device` binary + `-ports`/`-qmp`.
function vvdLine(consolePort: number, opts: { ports?: boolean } = {}): string {
  const { ports = true } = opts;
  let line =
    "/Users/me/vega/sdk/vega-sdk/main/0.22.6759/vvd/images/tv/vmtools/agent/qemu/" +
    "darwin-aarch64/vega-virtual-device -avd-arch arm64 -skin tv-remote";
  if (ports) line += ` -ports ${consolePort},${consolePort + 1}`;
  line += " -dns-server auto";
  line += ` -qemu -qmp unix:/tmp/qmp-socket-${consolePort}.sock,server,nowait`;
  return line;
}

// Must NOT yield a port: an Android emulator (has `-ports`, wrong process), a
// crashpad sibling under the SDK path, and a git ref that names the branch.
const ANDROID_EMULATOR =
  "/Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 " +
  "-avd Pixel_7 -ports 5554,5555";
const CRASHPAD =
  "/Users/me/vega/sdk/vega-sdk/main/0.22.6759/vvd/images/tv/vmtools/agent/crashpad_handler " +
  "--database=/tmp/x --annotation=prod=AndroidEmulator";
const GIT_REF = "git push --dry-run origin vega-review-work:krawipio/vega-virtual-device";

describe("parseVvdConsolePorts", () => {
  it("reads the console port from a running VVD's -ports flag", () => {
    expect([...parseVvdConsolePorts(vvdLine(5554))]).toEqual([5554]);
  });

  it("ignores a co-running Android emulator, a crashpad sibling, and a branch ref", () => {
    const ps = [ANDROID_EMULATOR, CRASHPAD, GIT_REF, vvdLine(5556)].join("\n");
    // The git ref matches the name gate but has no -ports/-qmp → no phantom port.
    expect([...parseVvdConsolePorts(ps)]).toEqual([5556]);
  });

  it("returns empty when no VVD process is present", () => {
    const ps = [ANDROID_EMULATOR, CRASHPAD, "/sbin/launchd"].join("\n");
    expect(parseVvdConsolePorts(ps).size).toBe(0);
  });

  it("reports every distinct console port when multiple VVDs run", () => {
    const ps = [vvdLine(5554), vvdLine(5556)].join("\n");
    expect([...parseVvdConsolePorts(ps)].sort((a, b) => a - b)).toEqual([5554, 5556]);
  });

  it("falls back to the qmp-socket path when -ports is absent", () => {
    expect([...parseVvdConsolePorts(vvdLine(5558, { ports: false }))]).toEqual([5558]);
  });

  it("matches the legacy kepler-virtual-device process name", () => {
    const line = vvdLine(5554).replace("vega-virtual-device", "kepler-virtual-device");
    expect([...parseVvdConsolePorts(line)]).toEqual([5554]);
  });

  it("does not match a `…-virtual-device-wrapper` substring", () => {
    const line = vvdLine(5554).replace("vega-virtual-device", "vega-virtual-device-wrapper");
    expect(parseVvdConsolePorts(line).size).toBe(0);
  });
});

// A `ps -o pid=,command=` line: a leading pid column, then the same argv.
function vvdPidLine(pid: number, consolePort: number): string {
  return `  ${pid} ${vvdLine(consolePort)}`;
}

describe("parseVvdPids", () => {
  it("reads the pid of a running VVD emulator process", () => {
    expect(parseVvdPids(vvdPidLine(75137, 5554))).toEqual([75137]);
  });

  it("ignores a co-running Android emulator, a crashpad sibling, and a branch ref", () => {
    const ps = [
      `  4242 ${ANDROID_EMULATOR}`,
      `  4243 ${CRASHPAD}`,
      `  4244 ${GIT_REF}`,
      vvdPidLine(75137, 5556),
    ].join("\n");
    expect(parseVvdPids(ps)).toEqual([75137]);
  });

  it("returns empty when no VVD process is present", () => {
    const ps = [`  1 /sbin/launchd`, `  4242 ${ANDROID_EMULATOR}`].join("\n");
    expect(parseVvdPids(ps)).toEqual([]);
  });

  it("reports every pid when multiple VVDs run", () => {
    const ps = [vvdPidLine(75137, 5554), vvdPidLine(80001, 5556)].join("\n");
    expect(parseVvdPids(ps).sort((a, b) => a - b)).toEqual([75137, 80001]);
  });

  it("matches the legacy kepler-virtual-device process name", () => {
    const line = vvdPidLine(75137, 5554).replace("vega-virtual-device", "kepler-virtual-device");
    expect(parseVvdPids(line)).toEqual([75137]);
  });

  it("does not match a `…-virtual-device-wrapper` substring", () => {
    const line = vvdPidLine(75137, 5554).replace(
      "vega-virtual-device",
      "vega-virtual-device-wrapper"
    );
    expect(parseVvdPids(line)).toEqual([]);
  });
});

// Exercises the REAL `ps` invocation (not mocked) so a flag invalid on the host —
// e.g. the BSD-only `-x` on the Linux CI runner — fails here, fast, instead of only
// surfacing in the slow Vega e2e (where the catch would otherwise hide it).
describe("listRunningVvdConsolePorts (real ps)", () => {
  it("PS_ARGS is accepted by the host `ps` (exit 0, non-empty output)", async () => {
    const { stdout } = await execFileAsync("ps", [...PS_ARGS], { maxBuffer: 16 * 1024 * 1024 });
    expect(stdout.split("\n").filter(Boolean).length).toBeGreaterThan(0);
  });

  it("resolves to a Set of positive console ports without throwing", async () => {
    const ports = await listRunningVvdConsolePorts();
    expect(ports).toBeInstanceOf(Set);
    for (const p of ports) expect(Number.isInteger(p) && p > 0).toBe(true);
  });

  it("PS_ARGS_WITH_PID is accepted by the host `ps` (exit 0, non-empty output)", async () => {
    const { stdout } = await execFileAsync("ps", [...PS_ARGS_WITH_PID], {
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(stdout.split("\n").filter(Boolean).length).toBeGreaterThan(0);
  });

  it("resolves to positive integer pids without throwing", async () => {
    const pids = await listRunningVvdPids();
    expect(Array.isArray(pids)).toBe(true);
    for (const p of pids) expect(Number.isInteger(p) && p > 0).toBe(true);
  });
});
