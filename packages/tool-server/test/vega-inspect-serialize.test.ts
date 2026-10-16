/**
 * On a VVD, overlapping toolkit `getPageSource` requests fail with "socket hang
 * up". A wait tool that hits its deadline leaves its read running, so the
 * describe that follows must queue behind it rather than overlap it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

const runAdb = vi.fn(async (..._a: unknown[]) => ({ stdout: "", stderr: "", code: 0 }));
const emulatorSerial = vi.fn();
vi.mock("../src/utils/adb", () => ({ runAdb: (...a: unknown[]) => runAdb(...a) }));
vi.mock("../src/utils/vega-automation", () => ({
  emulatorSerial: (...a: unknown[]) => emulatorSerial(...a),
}));

import { fetchVegaPageSource } from "../src/utils/vega-inspect";

// Must match HOST_PORT_OFFSET in vega-inspect.ts.
const HOST_PORT_OFFSET = 10_000;
const PAGE = '<root><window width="1920" height="1080"></window></root>';

let server: Server | undefined;

afterEach(async () => {
  runAdb.mockClear();
  if (server) {
    server.close();
    await once(server, "close").catch(() => {});
    server = undefined;
  }
});

/** Fake toolkit that, like the real one, fails every request that overlaps another. */
async function singleFlightToolkit(): Promise<{ maxInFlight: () => number }> {
  let inFlight = 0;
  let max = 0;
  server = createServer((req, res) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    req.resume();
    setTimeout(() => {
      const overlapped = max > 1;
      inFlight -= 1;
      if (overlapped) {
        res.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: PAGE }));
    }, 30);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const hostPort = (server.address() as AddressInfo).port;
  emulatorSerial.mockResolvedValue({
    serial: "emulator-5554",
    consolePort: hostPort - HOST_PORT_OFFSET,
  });
  return { maxInFlight: () => max };
}

describe("fetchVegaPageSource serializes reads of one VVD", () => {
  it("never sends a second getPageSource while one is in flight", async () => {
    const toolkit = await singleFlightToolkit();

    const results = await Promise.allSettled([
      fetchVegaPageSource(2000),
      fetchVegaPageSource(2000),
      fetchVegaPageSource(2000),
    ]);

    expect(toolkit.maxInFlight()).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  });

  it("removes each read's forward before the next read adds it", async () => {
    await singleFlightToolkit();

    await Promise.allSettled([fetchVegaPageSource(2000), fetchVegaPageSource(2000)]);

    const verbs = runAdb.mock.calls.map((c) =>
      (c[0] as string[])[3] === "--remove" ? "rm" : "add"
    );
    expect(verbs).toEqual(["add", "rm", "add", "rm"]);
  });
});
