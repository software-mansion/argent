import { describe, it, expect, vi } from "vitest";
import net from "node:net";

// Where `lsof` is missing, as in a slim Linux image, the console listener is
// read from /proc instead. Without either, the host cannot tell, which is not
// the same as a probe that failed this time.

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (_cmd: string, _args: readonly string[], _opts: unknown, cb: (e: Error) => void) =>
      cb(Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" })),
  };
});

import { consoleOwnership } from "../src/utils/emulator-process";

async function listen(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

describe("consoleOwnership without lsof", () => {
  it.runIf(process.platform === "linux")("reads the listener from /proc", async () => {
    const { server, port } = await listen();
    try {
      expect(await consoleOwnership(`emulator-${port}`, process.pid)).toBe("own");
      expect(await consoleOwnership(`emulator-${port}`, 2 ** 22 + 7)).toBe("other");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await consoleOwnership(`emulator-${port}`, process.pid)).toBe("free");
  });

  it.runIf(process.platform === "darwin")(
    "reports the listener unavailable elsewhere",
    async () => {
      const { server, port } = await listen();
      try {
        expect(await consoleOwnership(`emulator-${port}`, process.pid)).toBe("unavailable");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  );
});
