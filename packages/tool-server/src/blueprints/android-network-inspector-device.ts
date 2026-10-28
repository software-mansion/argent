import { adbShell, shellQuote } from "../utils/adb";

/**
 * The device side of the Android network inspector: what it reads from the
 * device and the shell it runs there. Everything here is a plain adb call; the
 * inspector decides what each answer means for capture.
 */

export const JAR_NAME = "network-inspector.jar";
export const AGENT_LIB_NAME = "libjvmti_network_inspector.so";
const SESSION_FILE_NAME = "session";
export const AGENT_ABIS = ["arm64-v8a", "x86_64"] as const;
export type AgentAbi = (typeof AGENT_ABIS)[number];

/** adb pushes here, and `run-as` copies into the app, which loads only from its own data. */
export const DEVICE_STAGING_DIR = "/data/local/tmp/.argent-inspector";

export interface AppProcess {
  pid: number;
  startTime: number;
}

export function processKey(proc: AppProcess): string {
  return `${proc.pid}:${proc.startTime}`;
}

/**
 * The agent's directory in the app's data for Android user `user`. Under
 * `code_cache`, which backups leave out and an app update clears, so nothing
 * outlives the build it was copied for. For user 0 it is the same directory as
 * `/data/data/<pkg>/code_cache/...`.
 */
export function agentDirFor(packageName: string, user: number): string {
  return `/data/user/${user}/${packageName}/code_cache/.argent-inspector`;
}

/**
 * `run-as` for the app as installed for `user`. `--user` goes after the
 * package, and only for a user other than 0: Android versions without the flag
 * know only user 0.
 */
export function runAsCommand(packageName: string, user: number, command: string): string {
  return `run-as ${shellQuote(packageName)}${user !== 0 ? ` --user ${user}` : ""} ${command}`;
}

interface DeviceFacts {
  sdk: number | null;
  /** The ABI the kernel runs natively, or null when `uname -m` names neither agent ABI. */
  kernelAbi: AgentAbi | null;
  kernelMachine: string;
  /**
   * `ro.serialno` of a physical device, the same for every adb connection to
   * it. Null for an emulator, where it tells nothing apart: every emulator of
   * one emulator version reports the same one.
   */
  hardwareKey: string | null;
  /** The foreground Android user; 0 when the device does not say. */
  user: number;
}

/** Everything the gates need from the device, in one adb round trip. */
export async function readDeviceFacts(serial: string): Promise<DeviceFacts> {
  const out = await adbShell(
    serial,
    [
      'echo "sdk=$(getprop ro.build.version.sdk)"',
      'echo "machine=$(uname -m)"',
      'echo "serialno=$(getprop ro.serialno)"',
      'echo "qemu=$(getprop ro.kernel.qemu)$(getprop ro.boot.qemu)"',
      'echo "user=$(am get-current-user 2>/dev/null)"',
    ].join("; "),
    { timeoutMs: 15_000 }
  );
  const fields = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const sdk = Number.parseInt(fields.get("sdk") ?? "", 10);
  const machine = fields.get("machine") ?? "";
  const serialNo = fields.get("serialno") ?? "";
  // Either property is 1 on an emulator, also one adb reaches over TCP.
  const emulator = serial.startsWith("emulator-") || (fields.get("qemu") ?? "").includes("1");
  const user = Number.parseInt(fields.get("user") ?? "", 10);
  return {
    sdk: Number.isFinite(sdk) ? sdk : null,
    kernelAbi: machine === "aarch64" ? "arm64-v8a" : machine === "x86_64" ? "x86_64" : null,
    kernelMachine: machine,
    hardwareKey: emulator ? null : serialNo || null,
    user: Number.isInteger(user) && user >= 0 ? user : 0,
  };
}

/**
 * The ABI the app's process runs as, which decides which agent can load in
 * it: a 64-bit phone still runs an app 32-bit when its APK ships only 32-bit
 * native libraries. `primaryCpuAbi` is null for an app with no native
 * libraries, which then runs as the device's primary ABI.
 */
export async function resolveAppAbi(serial: string, packageName: string): Promise<string> {
  const dump = await adbShell(
    serial,
    `dumpsys package ${shellQuote(packageName)} | grep -m1 primaryCpuAbi; true`,
    { timeoutMs: 15_000 }
  );
  const abi = /primaryCpuAbi=(\S+)/.exec(dump)?.[1];
  if (abi && abi !== "null") return abi;
  return (await adbShell(serial, "getprop ro.product.cpu.abi", { timeoutMs: 10_000 })).trim();
}

export interface AppProcesses {
  /** The foreground Android user, or null when the device did not say. */
  user: number | null;
  /** The app's processes of every Android user, in pidof's order. */
  processes: Array<AppProcess & { user: number }>;
}

/**
 * The foreground Android user and the app's processes, in one adb round trip,
 * so the process picked is the one of the user in the foreground then. pidof
 * also lists the app's processes in a work profile or another user, and only
 * the one whose files `run-as --user` reaches can load the agent. Each user has
 * a range of 100000 uids. The comm field of /proc/<pid>/stat can hold spaces,
 * so the start time is counted from the field after its closing parenthesis.
 */
export async function readAppProcesses(serial: string, packageName: string): Promise<AppProcesses> {
  const out = await adbShell(
    serial,
    [
      'echo "user=$(am get-current-user 2>/dev/null)"',
      `for p in $(pidof ${shellQuote(packageName)}); do echo "$p $(sed 's/.*) //' /proc/$p/stat | cut -d' ' -f20) $(grep '^Uid:' /proc/$p/status)"; done`,
    ].join("; "),
    { timeoutMs: 10_000 }
  );
  let user: number | null = null;
  const processes: AppProcesses["processes"] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    const foreground = /^user=(\d+)$/.exec(line);
    if (foreground) {
      user = Number(foreground[1]);
      continue;
    }
    const match = /^(\d+) (\d+) Uid:\s+(\d+)/.exec(line);
    if (match) {
      processes.push({
        pid: Number(match[1]),
        startTime: Number(match[2]),
        user: Math.floor(Number(match[3]) / 100_000),
      });
    }
  }
  return { user, processes };
}

/** The app's process for Android user `user`, or null when none runs. */
export function processOfUser(read: AppProcesses, user: number): AppProcess | null {
  const found = read.processes.find((p) => p.user === user);
  return found ? { pid: found.pid, startTime: found.startTime } : null;
}

/**
 * Runs as the app with the session line on its stdin: writes the session file,
 * owner-only and replaced in one rename.
 */
export function sessionScript(agentDir: string): string {
  const session = `${agentDir}/${SESSION_FILE_NAME}`;
  return [
    "umask 077",
    `mkdir -p ${agentDir}`,
    `cat > ${session}.tmp`,
    `mv -f ${session}.tmp ${session}`,
  ].join(" && ");
}

/**
 * The script that runs as the app on every attach attempt, with the session
 * line on its stdin: it writes the session file (see `sessionScript`), then
 * reports whether `pid` already maps the agent and copies the agent in when it
 * does not.
 */
export function attachScript(agentDir: string, pid: number): string {
  const jar = `${agentDir}/${JAR_NAME}`;
  const lib = `${agentDir}/${AGENT_LIB_NAME}`;
  const copy = [
    // A read-only copy from an earlier attach cannot be overwritten in place.
    `rm -f ${jar} ${lib}`,
    `cp ${DEVICE_STAGING_DIR}/${JAR_NAME} ${jar}`,
    `cp ${DEVICE_STAGING_DIR}/${AGENT_LIB_NAME} ${lib}`,
    // Android 14 and later refuse to load a writable dex file.
    `chmod 444 ${jar}`,
    `chmod 555 ${lib}`,
    "echo copied",
  ].join(" && ");
  return [
    sessionScript(agentDir),
    `if grep -q ${AGENT_LIB_NAME} /proc/${pid}/maps; then echo loaded; else ${copy}; fi`,
  ].join(" && ");
}

/**
 * Removes the agent's directory only while its session file still holds the
 * secret on stdin: once another tool-server wrote its own session there, the
 * files are that one's. Only shell builtins see the secret, so it stays out of
 * every command line.
 */
export function removeSessionScript(agentDir: string): string {
  const session = `${agentDir}/${SESSION_FILE_NAME}`;
  return `IFS= read -r s; case "$(cat ${session} 2>/dev/null)" in *"\\"secret\\":\\"$s\\""*) rm -rf ${agentDir};; esac`;
}

/** What a `run-as` failure says about the app, from its message. */
type RunAsFailure = "not_debuggable" | "not_application" | "unknown_package" | "other";

export function classifyRunAsFailure(detail: string): RunAsFailure {
  if (/package not debuggable/i.test(detail)) return "not_debuggable";
  if (/package not an application/i.test(detail)) return "not_application";
  if (/unknown package/i.test(detail)) return "unknown_package";
  // The app has no data directory for that Android user: it is not installed
  // for the user, or the user does not exist.
  if (/couldn't stat \/data\/(?:user\/\d+|data)\b/i.test(detail)) return "unknown_package";
  return "other";
}
