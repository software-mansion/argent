import { describe, it, expect, vi, beforeEach } from "vitest";

// Control the filesystem the VVD socket discovery probes. tmpdir() is forced to
// a distinct path from /tmp so both probed dirs are exercised (the macOS case).
const readdir = vi.fn();
vi.mock("node:fs/promises", () => ({ readdir: (...a: unknown[]) => readdir(...a) }));
vi.mock("node:os", () => ({ tmpdir: () => "/var/folders/T" }));

import {
  discoverQmpSocket,
  discoverVegaConsolePort,
  MultipleVegaDevicesError,
} from "../src/utils/vega-vvd";

function withSockets(byDir: Record<string, string[]>): void {
  readdir.mockImplementation(async (dir: string) => byDir[dir] ?? []);
}

beforeEach(() => {
  readdir.mockReset();
});

describe("discoverQmpSocket", () => {
  it("returns the sole VVD socket path (ignoring unrelated files)", async () => {
    withSockets({ "/tmp": ["qmp-socket-5554.sock", "not-a-socket.txt"] });
    expect(await discoverQmpSocket()).toBe("/tmp/qmp-socket-5554.sock");
  });

  it("derives the emulator console port from the socket name", async () => {
    withSockets({ "/tmp": ["qmp-socket-5556.sock"] });
    expect(await discoverVegaConsolePort()).toBe(5556);
  });

  it("throws an actionable error when no VVD socket is present", async () => {
    withSockets({});
    await expect(discoverQmpSocket()).rejects.toThrow(/No Vega Virtual Device QMP socket/);
  });

  it("throws a typed MultipleVegaDevicesError rather than silently targeting one", async () => {
    withSockets({ "/tmp": ["qmp-socket-5554.sock", "qmp-socket-5556.sock"] });
    await expect(discoverQmpSocket()).rejects.toBeInstanceOf(MultipleVegaDevicesError);
    await expect(discoverQmpSocket()).rejects.toThrow(/Multiple Vega Virtual Devices detected/);
  });

  it("counts one device when the same socket surfaces under both probed dirs", async () => {
    // The VVD writes to /tmp; if tmpdir() also surfaced it, dedupe-by-filename
    // must keep it a single device rather than tripping the multi-device guard.
    withSockets({
      "/var/folders/T": ["qmp-socket-5554.sock"],
      "/tmp": ["qmp-socket-5554.sock"],
    });
    expect(await discoverQmpSocket()).toMatch(/qmp-socket-5554\.sock$/);
  });
});
