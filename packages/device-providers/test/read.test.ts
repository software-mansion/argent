import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetProviderWarningsForTesting,
  descriptorFiles,
  discoverProviders,
  providersDirectory,
  readProviderDevices,
  readProviderFile,
} from "../src/index.js";
import { androidDevice, classify, descriptor, iosDevice, IOS_UDID } from "./fixtures.js";

let home: string;
let providersDir: string;

function write(name: string, body: unknown): string {
  const file = path.join(providersDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-dp-read-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  providersDir = path.join(home, ".argent", "providers");
  fs.mkdirSync(providersDir, { recursive: true });
  __resetProviderWarningsForTesting();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("providersDirectory", () => {
  it("hangs off the home directory, resolved per call", () => {
    expect(providersDirectory()).toBe(providersDir);
  });
});

describe("discovery", () => {
  it("fans out across several descriptor files", () => {
    write("acme.json", descriptor());
    write("zenith.json", descriptor({ devices: [androidDevice()], id: "zenith", name: "Zenith" }));

    expect(
      discoverProviders()
        .map((record) => record.id)
        .sort()
    ).toEqual(["acme-3f2a9c", "zenith"]);
  });

  it("keeps only the first descriptor claiming a given id", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    write("a-first.json", descriptor({ name: "First" }));
    write("b-second.json", descriptor({ name: "Second" }));

    const records = discoverProviders();
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("First");
  });

  it("skips an unknown schemaVersion without failing, and says so once", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    write("future.json", descriptor({ schemaVersion: 2 }));

    expect(discoverProviders()).toEqual([]);
    discoverProviders();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toContain("unsupported schemaVersion 2");
  });

  it("ignores a file that is not JSON at all", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    write("broken.json", "{ not json");
    expect(discoverProviders()).toEqual([]);
  });

  it("ignores everything that is not a .json file", () => {
    write("acme.json", descriptor());
    write("notes.txt", "irrelevant");

    expect(descriptorFiles()).toEqual([path.join(providersDir, "acme.json")]);
  });

  it("treats a missing file as absent", () => {
    expect(readProviderFile(path.join(providersDir, "nope.json"))).toBeUndefined();
  });

  it("treats a missing providers directory as no providers", () => {
    fs.rmSync(providersDir, { recursive: true, force: true });
    expect(discoverProviders()).toEqual([]);
    expect(descriptorFiles()).toEqual([]);
  });

  /**
   * A stale descriptor belongs to another process and deleting it is
   * unrecoverable.
   */
  it("never unlinks a descriptor, whatever is wrong with it", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const files = [
      write("broken.json", "{ not json"),
      write("future.json", descriptor({ schemaVersion: 7 })),
      write("shapeless.json", { id: "acme", schemaVersion: 1 }),
    ];

    discoverProviders();

    for (const file of files) expect(fs.existsSync(file)).toBe(true);
  });

  it("skips discovery entirely under ARGENT_DISABLE_DEVICE_PROVIDERS", () => {
    write("acme.json", descriptor());
    process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
    expect(discoverProviders()).toEqual([]);
  });

  it("reads exactly the files ARGENT_DEVICE_PROVIDERS names, ignoring the directory", () => {
    write("in-the-directory.json", descriptor({ id: "ignored", name: "Ignored" }));

    const sandbox = path.join(home, "elsewhere.json");
    fs.writeFileSync(sandbox, JSON.stringify(descriptor()));
    process.env.ARGENT_DEVICE_PROVIDERS = ` ${sandbox} , `;

    expect(discoverProviders().map((record) => record.id)).toEqual(["acme-3f2a9c"]);
  });

  it("carries the source path for diagnostics", () => {
    const file = write("acme.json", descriptor());
    expect(discoverProviders()[0]!.sourcePath).toBe(file);
  });

  it("keeps a pid the provider declared", () => {
    write("acme.json", descriptor({ pid: 4321 }));
    expect(discoverProviders()[0]!.pid).toBe(4321);
  });
});

describe("readProviderDevices", () => {
  it("drops one bad device without costing the provider its whole list", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    write("acme.json", descriptor({ devices: [{ nativeId: "junk" }, iosDevice()] }));

    const devices = readProviderDevices(discoverProviders()[0]!, classify);
    expect(devices.map((device) => device.nativeId)).toEqual([IOS_UDID]);
  });

  it("rejects a device whose declared platform disagrees with its id's shape", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    write("acme.json", descriptor({ devices: [iosDevice({ platform: "android" })] }));

    expect(readProviderDevices(discoverProviders()[0]!, classify)).toEqual([]);
  });

  it("filters unknown capability tokens out of the adopted device", () => {
    write(
      "acme.json",
      descriptor({ devices: [iosDevice({ capabilities: ["simctl", "teleportation"] })] })
    );

    const [device] = readProviderDevices(discoverProviders()[0]!, classify);
    expect(Array.from(device!.capabilities)).toEqual(["simctl"]);
  });

  it("joins each device to the provider that served it", () => {
    write("acme.json", descriptor());

    const [device] = readProviderDevices(discoverProviders()[0]!, classify);

    expect(device!.id).toBe(`ext:acme-3f2a9c:${IOS_UDID}`);
    expect(device!.provider).toEqual({
      id: "acme-3f2a9c",
      name: "Acme IDE",
      supportUrl: "https://example.invalid/issues",
      workspace: { name: "my-app", path: "/Users/me/src/my-app" },
    });
  });
});
