import { argentHomeDir } from "@argent/configuration-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAdbDevices, runAdb } from "./adb";

// A wireless adb serial can change on reconnect. The kernel boot ID identifies
// the phone for exactly as long as its orphan could still exist. The other
// fields distinguish even a new mirror that reuses the same socket or PID.
const BOOT = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const RECORD = new RegExp(`^(${BOOT})_(\\d+)_(\\d+)_(screen-sharing-agent-\\d+)$`);
const TIMEOUT = { timeoutMs: 5_000 };
const directory = () => path.join(argentHomeDir(), "pending-android-agents");
const shell = async (serial: string, script: string) =>
  (await runAdb(["-s", serial, "shell", script], TIMEOUT)).stdout.trim();

function processPattern(socket: string): string {
  return `^app_process .*com[.]android[.]tools[.]screensharing[.]Main --socket=${socket}( |$)`;
}

export async function identifyAgent(serial: string, socket: string): Promise<string | null> {
  if (!/^screen-sharing-agent-\d+$/.test(socket)) return null;
  try {
    const record = await shell(
      serial,
      `set -- $(pgrep -f '${processPattern(socket)}'); [ "$#" = 1 ] || exit 1; ` +
        `echo "$(cat /proc/sys/kernel/random/boot_id)_\${1}_$(awk '{print $22}' /proc/$1/stat)_${socket}"`
    );
    return RECORD.test(record) ? record : null;
  } catch {
    return null;
  }
}

// One empty file per orphan: independent tool-servers cannot overwrite one
// another's pending items. No running session is put in the retry directory.
export async function rememberAgent(record: string): Promise<void> {
  if (!RECORD.test(record)) return;
  await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory(), record), "", { mode: 0o600 });
  scheduleAgentRetries();
}

export async function forgetAgent(record: string): Promise<void> {
  if (RECORD.test(record)) await fs.rm(path.join(directory(), record), { force: true });
}

export async function retryPendingAgents(): Promise<void> {
  const dir = directory();
  const pending = (await fs.readdir(dir)).filter((name) => RECORD.test(name));
  if (!pending.length) return;
  // A device that never returns (or reboots) cannot be matched again.
  const fresh: string[] = [];
  for (const name of pending) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!stat) continue;
    if (Date.now() - stat.mtimeMs > 7 * 86_400_000) await forgetAgent(name);
    else fresh.push(name);
  }
  if (!fresh.length) return;
  const { stdout } = await runAdb(["devices"], TIMEOUT);
  for (const { serial, state } of parseAdbDevices(stdout)) {
    if (state !== "device") continue;
    const boot = await shell(serial, "cat /proc/sys/kernel/random/boot_id").catch(() => "");
    for (const name of fresh) {
      const [, expectedBoot, pid, start, socket] = RECORD.exec(name)!;
      if (boot !== expectedBoot) continue;
      // Check again inside the same adb shell that sends the signal. Between
      // two adb invocations this address might have become a different phone.
      const outcome = await shell(
        serial,
        `[ "$(cat /proc/sys/kernel/random/boot_id)" = '${boot}' ] || exit 1; ` +
          `if [ ! -d /proc/${pid} ]; then echo gone; ` +
          `elif ! ticks=$(awk '{print $22}' /proc/${pid}/stat); then exit 1; ` +
          `elif [ "$ticks" != '${start}' ]; then echo gone; ` +
          `elif pgrep -f '${processPattern(socket!)}' | grep -qx '${pid}'; then ` +
          `kill ${pid} && echo stopped; fi`
      ).catch(() => "");
      if (outcome === "stopped") {
        process.stderr.write(
          `[argent] stopped a leftover screen-sharing agent after reconnect (socket ${socket})\n`
        );
        await runAdb(
          ["-s", serial, "reverse", "--remove", `localabstract:${socket}`],
          TIMEOUT
        ).catch(() => {});
      }
      if (outcome === "stopped" || outcome === "gone") await forgetAgent(name);
    }
  }
}

let scheduled = false;
export function scheduleAgentRetries(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(async () => {
    try {
      await retryPendingAgents();
    } catch {
      // Missing directory on first run, offline adb daemon, or concurrent cleanup.
    } finally {
      scheduled = false;
      if ((await fs.readdir(directory()).catch(() => [])).some((name) => RECORD.test(name))) {
        scheduleAgentRetries();
      }
    }
  }, 15_000).unref();
}
