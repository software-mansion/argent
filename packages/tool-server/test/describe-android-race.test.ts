import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string | Buffer; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { createDescribeTool } from "../src/tools/interactions/describe";
import { __resetClassifyCacheForTests, warmDeviceCache } from "../src/utils/platform-detect";

const registry: Registry = { resolveService: vi.fn() } as unknown as Registry;
let nextSerial = 8000;
const mkSerial = () => `emulator-${nextSerial++}`;

function tinyDump(): string {
  return `<?xml version='1.0' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" bounds="[0,0][100,100]" text="" resource-id="" content-desc="" package="com.x" />
</hierarchy>`;
}

beforeEach(() => {
  execFileMock.mockReset();
  __resetClassifyCacheForTests();
});

describe("describe — per-call dump path (review #10)", () => {
  /**
   * The old implementation wrote every dump to the same fixed path
   * (`/sdcard/window_dump.xml`). Two parallel describe calls on the same
   * serial would race on that file: one call's `cat` read could overlap with
   * the other call's write, producing truncated XML.
   *
   * Fix: each call generates its own `/data/local/tmp/argent-ui-dump-<rand>.xml`
   * path. These tests pin that behavior by asserting the shell command uses a
   * unique, safe-location path per call.
   */

  it("uses a unique per-call dump file path — no shared /sdcard/window_dump.xml", async () => {
    const shellCommands: string[] = [];
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      // Screen size probe is a plain shell getprop; pass through.
      if (cmd === "adb" && args.includes("wm size")) {
        return { stdout: "Physical size: 1000x1000\n", stderr: "" };
      }
      // `exec-out` is how we cat the dump file. Capture the shell command.
      if (cmd === "adb" && args.includes("exec-out")) {
        shellCommands.push(args[args.length - 1] ?? "");
        return { stdout: Buffer.from(tinyDump(), "utf-8"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createDescribeTool(registry);
    const serial = mkSerial();
    warmDeviceCache([{ udid: serial, platform: "android" }]);

    await tool.execute({}, { udid: serial });
    await tool.execute({}, { udid: serial });

    expect(shellCommands).toHaveLength(2);

    // Neither call should use the old shared path.
    for (const cmd of shellCommands) {
      expect(cmd).not.toContain("/sdcard/window_dump.xml");
    }

    // Both calls should use distinct randomized paths under /data/local/tmp.
    const pathA = /argent-ui-dump-[^\s]+\.xml/.exec(shellCommands[0]!)?.[0];
    const pathB = /argent-ui-dump-[^\s]+\.xml/.exec(shellCommands[1]!)?.[0];
    expect(pathA).toBeDefined();
    expect(pathB).toBeDefined();
    expect(pathA).not.toBe(pathB);

    // And both should clean up after themselves — concurrent calls must not
    // leave dump files growing on /data/local/tmp indefinitely.
    expect(shellCommands[0]).toMatch(/rm -f \/data\/local\/tmp\/argent-ui-dump-/);
    expect(shellCommands[1]).toMatch(/rm -f \/data\/local\/tmp\/argent-ui-dump-/);
  });

  it("writes the dump to /data/local/tmp (world-writable on every supported Android)", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "adb" && args.includes("wm size")) {
        return { stdout: "Physical size: 1000x1000\n", stderr: "" };
      }
      if (cmd === "adb" && args.includes("exec-out")) {
        const shell = args[args.length - 1] ?? "";
        // `uiautomator dump <path>` has stricter permissions requirements
        // than `echo` — targeting /sdcard used to work but silently fails
        // on recent Android with scoped storage; /data/local/tmp is the
        // reliable common denominator.
        expect(shell.startsWith("uiautomator dump /data/local/tmp/argent-ui-dump-")).toBe(true);
        return { stdout: Buffer.from(tinyDump(), "utf-8"), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createDescribeTool(registry);
    const serial = mkSerial();
    warmDeviceCache([{ udid: serial, platform: "android" }]);
    await tool.execute({}, { udid: serial });
  });
});
