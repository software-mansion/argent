import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isProcessAlive,
  ProviderValidationError,
  pruneOrphanedProviders,
  providersDirectory,
  publishProvider,
  withdrawProvider,
} from "../src/index.js";
import { descriptor, iosDevice, IOS_UDID } from "./fixtures.js";

let home: string;
let providersDir: string;

/** A pid nothing can be running under, so `kill(0)` fails with ESRCH. */
const DEAD_PID = 0x7fffffff;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-dp-write-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  providersDir = path.join(home, ".argent", "providers");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("publishProvider", () => {
  it("writes the canonical <id>.json, creating the directory", () => {
    expect(fs.existsSync(providersDir)).toBe(false);

    const result = publishProvider(descriptor());

    expect(result.path).toBe(path.join(providersDir, "acme-3f2a9c.json"));
    expect(result.changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.path, "utf8")).id).toBe("acme-3f2a9c");
  });

  /**
   * Argent keeps only the first file claiming an id, so a provider choosing its
   * own filename can shadow itself across a restart.
   */
  it("updates in place rather than accumulating a file per publish", () => {
    publishProvider(descriptor());
    publishProvider(descriptor({ name: "Acme IDE 2" }));

    expect(fs.readdirSync(providersDir)).toEqual(["acme-3f2a9c.json"]);
    expect(
      JSON.parse(fs.readFileSync(path.join(providersDir, "acme-3f2a9c.json"), "utf8")).name
    ).toBe("Acme IDE 2");
  });

  it("does not touch the file when the document is unchanged", async () => {
    const first = publishProvider(descriptor());
    const before = fs.statSync(first.path).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 15));

    const second = publishProvider(descriptor());

    expect(second.changed).toBe(false);
    expect(fs.statSync(second.path).mtimeMs).toBe(before);
  });

  it("is insensitive to key order, so a rebuilt document still dedupes", () => {
    publishProvider(descriptor());
    const reordered = { schemaVersion: 1, ...descriptor() };
    expect(publishProvider(reordered).changed).toBe(false);
  });

  it("leaves no temporary file behind", () => {
    publishProvider(descriptor());
    expect(fs.readdirSync(providersDir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("records the pid the caller supplies, overriding the document's", () => {
    const result = publishProvider(descriptor({ pid: 111 }), { pid: 222 });
    expect(JSON.parse(fs.readFileSync(result.path, "utf8")).pid).toBe(222);
  });

  it("omits pid entirely when neither the document nor the caller has one", () => {
    const result = publishProvider(descriptor());
    expect("pid" in JSON.parse(fs.readFileSync(result.path, "utf8"))).toBe(false);
  });

  it("throws with the issues for a descriptor argent would reject", () => {
    let thrown: unknown;

    try {
      publishProvider(descriptor({ id: "Not A Slug" }));
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ProviderValidationError);
    expect((thrown as ProviderValidationError).issues.join("\n")).toContain("id:");
    expect(fs.existsSync(providersDir)).toBe(false);
  });

  /**
   * Two entries for one `nativeId` collapse to a single, ambiguous `ext:` id.
   */
  it("refuses a descriptor listing one device twice", () => {
    expect(() => publishProvider(descriptor({ devices: [iosDevice(), iosDevice()] }))).toThrow(
      ProviderValidationError
    );
  });

  it("refuses a malformed device even though discovery would only drop it", () => {
    expect(() => publishProvider(descriptor({ devices: [{ nativeId: "junk" }] }))).toThrow(
      ProviderValidationError
    );
  });

  /**
   * An older CLI may publish for a newer tool-server, so fields this build does
   * not know must survive the write.
   */
  it("preserves fields the contract does not define, top-level and per device", () => {
    const result = publishProvider(
      descriptor({
        devices: [{ ...iosDevice(), futureDeviceField: "kept" }],
        futureField: { nested: true },
      })
    );
    const written = JSON.parse(fs.readFileSync(result.path, "utf8"));
    expect(written.futureField).toEqual({ nested: true });
    expect(written.devices[0].futureDeviceField).toBe("kept");
  });

  it("round-trips a device through publish unharmed", () => {
    const result = publishProvider(descriptor());
    const written = JSON.parse(fs.readFileSync(result.path, "utf8"));
    expect(written.devices[0].nativeId).toBe(IOS_UDID);
    expect(written.devices[0].simulatorServer.version).toBe("1.20.0");
  });
});

describe("withdrawProvider", () => {
  it("removes the descriptor and reports that it did", () => {
    const { path: file } = publishProvider(descriptor());
    expect(withdrawProvider("acme-3f2a9c")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("is a no-op for an id that was never published", () => {
    fs.mkdirSync(providersDir, { recursive: true });
    expect(withdrawProvider("never-published")).toBe(false);
  });

  it("refuses an id that is not a provider id, before it reaches a path", () => {
    expect(() => withdrawProvider("../../etc/passwd")).toThrow(/not a valid provider id/);
  });
});

describe("isProcessAlive", () => {
  it("knows this process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("knows an unused pid is not", () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });

  it("rejects a pid that could never name a process", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  /**
   * EPERM means alive under another user. Reading it as dead deletes theirs.
   */
  it("counts a process owned by another user as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    expect(isProcessAlive(1)).toBe(true);
  });
});

describe("pruneOrphanedProviders", () => {
  function publishWith(id: string, pid: number | undefined): string {
    return publishProvider(descriptor({ id, ...(pid === undefined ? {} : { pid }) })).path;
  }

  it("removes a descriptor whose process is dead", () => {
    const file = publishWith("acme-dead", DEAD_PID);

    const removed = pruneOrphanedProviders();

    expect(removed).toEqual([{ id: "acme-dead", name: "Acme IDE", path: file, pid: DEAD_PID }]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps a descriptor whose process is alive", () => {
    const file = publishWith("acme-live", process.pid);
    expect(pruneOrphanedProviders()).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  /** No pid is not evidence of death, just a provider that opted out. */
  it("keeps a descriptor that declares no pid", () => {
    const file = publishWith("acme-quiet", undefined);
    expect(pruneOrphanedProviders()).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("keeps a file it cannot parse — ownership unproven", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    fs.mkdirSync(providersDir, { recursive: true });
    const file = path.join(providersDir, "mystery.json");
    fs.writeFileSync(file, "{ not json");

    expect(pruneOrphanedProviders()).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("respects a vendor filter, so a provider prunes only its own", () => {
    const mine = publishWith("acme-dead", DEAD_PID);
    const theirs = publishWith("zenith-dead", DEAD_PID);

    const removed = pruneOrphanedProviders({ filter: (record) => record.id.startsWith("acme-") });

    expect(removed.map((entry) => entry.id)).toEqual(["acme-dead"]);
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it("is a no-op when the providers directory does not exist", () => {
    expect(pruneOrphanedProviders()).toEqual([]);
  });

  /** A dry run shares the decision and skips only the unlink. */
  it("reports without removing under dryRun", () => {
    const file = publishWith("acme-dead", DEAD_PID);

    expect(pruneOrphanedProviders({ dryRun: true }).map((entry) => entry.path)).toEqual([file]);
    expect(fs.existsSync(file)).toBe(true);

    expect(pruneOrphanedProviders().map((entry) => entry.path)).toEqual([file]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("does not disturb the directory it pruned from", () => {
    publishWith("acme-dead", DEAD_PID);
    pruneOrphanedProviders();
    expect(fs.existsSync(providersDirectory())).toBe(true);
  });
});
