import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startPerfetto } from "../src/utils/android-profiler/capture";
import { makeExternalId } from "../src/utils/external-devices";

/**
 * Perfetto is the one `adb` caller that spawns for itself: the trace config
 * goes in on stdin and the daemon's PID comes back on stdout, which `runAdb`
 * (whose contract is "run to completion, give me the output") cannot express.
 * So it is also the one place `adb` can be handed a serial `runAdb` never
 * substituted.
 *
 * The substitution also enforces the `adb` grant, so the external cases here
 * publish a real descriptor.
 */

/** Every `adb` the capture spawns, so its argv can be asserted on. */
const rec = vi.hoisted(() => ({ spawned: [] as { file: string; args: string[] }[] }));

/**
 * An `adb shell perfetto --background-wait` that prints a PID and exits, which
 * is all `startPerfetto` waits for.
 */
const fakeAdb = vi.hoisted(() => () => {
  const stdoutListeners: ((chunk: Buffer) => void)[] = [];

  /**
   * `startPerfetto` subscribes twice (once to accumulate the output, once to
   * parse it), so the PID goes out after both have registered rather than on
   * each subscription. `error` and `exit` stay unwired, reaching them would
   * mean the start failed.
   */
  setImmediate(() => {
    for (const listener of stdoutListeners) listener(Buffer.from("4242\n"));
  });

  return {
    kill: () => true,
    on: () => {},
    once: () => {},
    stderr: { on: () => {} },
    stdin: { end: () => {}, on: () => {}, write: () => true },
    stdout: {
      on: (_event: string, listener: (chunk: Buffer) => void) => {
        stdoutListeners.push(listener);
      },
    },
  };
});

vi.mock("child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (err: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    callback(null, { stderr: "", stdout: "" });
  },
  spawn: (file: string, args: string[]) => {
    rec.spawned.push({ args, file });
    return fakeAdb();
  },
}));

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: async () => "adb",
  __resetAndroidBinaryCacheForTesting: () => {},
}));

const SERIAL = "emulator-5554";
const DEVICE_ID = makeExternalId("acme-3f2a9c", SERIAL);

let temporaryDirectory: string;

function publishDescriptor(capabilities: string[]): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities,
          kind: "emulator",
          name: "Pixel 8",
          nativeId: SERIAL,
          platform: "android",
          state: "device",
        },
      ],
      id: "acme-3f2a9c",
      name: "Acme IDE",
      schemaVersion: 1,
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
}

beforeEach(() => {
  rec.spawned.length = 0;
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-perfetto-"));
});

afterEach(() => {
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("perfetto on a provider's emulator", () => {
  it("targets the serial adb knows, not the argent-side id", async () => {
    publishDescriptor(["adb", "native-profiler"]);

    const { pid } = await startPerfetto({
      appPackage: "com.example.app",
      serial: DEVICE_ID,
      timestamp: "20260804-120000",
    });

    expect(pid).toBe(4242);

    const [adb] = rec.spawned;
    expect(adb.file).toBe("adb");
    expect(adb.args[adb.args.indexOf("-s") + 1]).toBe(SERIAL);
    expect(adb.args.filter((argument) => argument.includes("ext:"))).toEqual([]);
  });

  /**
   * Withholding `adb` blocks the capture, whatever other grants the device
   * carries.
   */
  it("refuses to start when the provider withheld adb", async () => {
    publishDescriptor(["native-profiler"]);

    await expect(
      startPerfetto({
        appPackage: "com.example.app",
        serial: DEVICE_ID,
        timestamp: "20260804-120000",
      })
    ).rejects.toThrow(/'adb' capability/);

    expect(rec.spawned).toEqual([]);
  });

  it("leaves a plain serial exactly as it was given", async () => {
    await startPerfetto({
      appPackage: "com.example.app",
      serial: SERIAL,
      timestamp: "20260804-120000",
    });

    const [adb] = rec.spawned;
    expect(adb.args[adb.args.indexOf("-s") + 1]).toBe(SERIAL);
  });
});
