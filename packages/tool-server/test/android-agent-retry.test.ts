import { FAILURE_CODES, FailureError } from "@argent/registry";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberAgent, retryPendingAgents } from "../src/utils/android-agent-retry";
import { reapAndroidScreenSharingAgent } from "../src/utils/android-agent-reap";
import { runAdb } from "../src/utils/adb";

let home: string;
vi.mock("@argent/configuration-core", async (load) => ({
  ...(await load<typeof import("@argent/configuration-core")>()),
  argentHomeDir: () => home,
}));
vi.mock("../src/utils/adb", async (load) => ({
  ...(await load<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(),
}));

const boot = "01234567-89ab-cdef-0123-456789abcdef";
const socket = "screen-sharing-agent-45000";
const record = `${boot}_345_6789_${socket}`;
const records = () => readdir(join(home, "pending-android-agents"));

describe("pending Android agent cleanup", () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "argent-agent-retry-"));
    vi.mocked(runAdb).mockReset();
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it.each([true, false])(
    "queues a retry only if teardown lost transport (online=%s)",
    async (online) => {
      vi.mocked(runAdb).mockImplementation(async (args) => {
        if (args[2] !== "shell") return { stdout: "", stderr: "" };
        // A clean exit leaves no agent for pkill. A disconnected adb also
        // exits 1, but never runs the remote shell in the first place.
        const code = online
          ? spawnSync("sh", ["-c", `pkill() { return 1; }; ${args[3]}`]).status!
          : 1;
        throw new FailureError(`adb exited ${code}`, {
          error_code: FAILURE_CODES.ANDROID_ADB_COMMAND_FAILED,
          failure_stage: "android_adb_command",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_exit_code: code,
        });
      });
      await reapAndroidScreenSharingAgent("usb", socket, record);
      expect(await records()).toEqual(online ? [] : [record]);
    }
  );

  it("keeps the record offline, then reaps through a new transport for the same boot", async () => {
    await rememberAgent(record);
    vi.mocked(runAdb).mockResolvedValueOnce({ stdout: "old:123 offline", stderr: "" });
    await retryPendingAgents();
    expect(await records()).toEqual([record]);
    vi.mocked(runAdb).mockImplementation(async (args) => {
      if (args[0] === "devices") return { stdout: "other device\nUSB123 device", stderr: "" };
      if (args[1] === "other") return { stdout: "different-boot", stderr: "" };
      if (args[3] === "cat /proc/sys/kernel/random/boot_id") return { stdout: boot, stderr: "" };
      if (args[2] === "shell") return { stdout: "stopped", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await retryPendingAgents();
    expect(await records()).toEqual([]);
    expect(vi.mocked(runAdb).mock.calls.filter(([args]) => args[1] === "other")).toHaveLength(1);
    expect(runAdb).toHaveBeenCalledWith(
      ["-s", "USB123", "reverse", "--remove", `localabstract:${socket}`],
      expect.anything()
    );
  });

  it("does not remove a reused socket when the original process is gone", async () => {
    await rememberAgent(record);
    vi.mocked(runAdb)
      .mockResolvedValueOnce({ stdout: "usb device", stderr: "" })
      .mockResolvedValueOnce({ stdout: boot, stderr: "" })
      .mockResolvedValueOnce({ stdout: "gone", stderr: "" });
    await retryPendingAgents();
    expect(await records()).toEqual([]);
    expect(vi.mocked(runAdb).mock.calls.some(([args]) => args.includes("--remove"))).toBe(false);
  });
});
