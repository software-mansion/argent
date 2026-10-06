import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { adbServerAddress, adbServerShell } from "../src/utils/adb-server";

/**
 * A fake adb server speaking just enough of the real protocol (4-hex-digit
 * length prefix, OKAY/FAIL statuses, `host:transport:` then `shell:`) to drive
 * `adbServerShell` end to end over a real socket. Every scenario is a script of
 * how the server reacts to each message it receives.
 */
type Script = (message: string, socket: net.Socket, index: number) => void;

const servers: net.Server[] = [];

async function fakeAdbServer(script: Script): Promise<number> {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    let index = 0;
    socket.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 4) {
        const len = parseInt(pending.subarray(0, 4).toString("latin1"), 16);
        if (pending.length < 4 + len) return;
        const message = pending.subarray(4, 4 + len).toString("utf8");
        pending = pending.subarray(4 + len);
        script(message, socket, index++);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

const fail = (socket: net.Socket, message: string) =>
  socket.write(`FAIL${message.length.toString(16).padStart(4, "0")}${message}`);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  delete process.env.ADB_SERVER_SOCKET;
  delete process.env.ANDROID_ADB_SERVER_ADDRESS;
  delete process.env.ANDROID_ADB_SERVER_PORT;
});

describe("adbServerShell", () => {
  it("selects the device, runs the command and returns its output", async () => {
    const seen: string[] = [];
    const port = await fakeAdbServer((message, socket) => {
      seen.push(message);
      if (message.startsWith("host:transport:")) socket.write("OKAY");
      else if (message.startsWith("shell:")) {
        socket.write("OKAY");
        socket.end("mCurrentOrientation=1\n");
      }
    });
    process.env.ANDROID_ADB_SERVER_PORT = String(port);

    const out = await adbServerShell("emulator-5554", "dumpsys display | grep mCurrentOrientation");

    expect(out).toBe("mCurrentOrientation=1\n");
    expect(seen).toEqual([
      "host:transport:emulator-5554",
      "shell:dumpsys display | grep mCurrentOrientation",
    ]);
  });

  it("handles output that arrives in the same packet as the OKAY", async () => {
    const port = await fakeAdbServer((message, socket) => {
      if (message.startsWith("host:transport:")) socket.write("OKAY");
      else socket.end("OKAYmRotation=3\n");
    });
    process.env.ANDROID_ADB_SERVER_PORT = String(port);

    expect(await adbServerShell("emulator-5554", "x")).toBe("mRotation=3\n");
  });

  it("rejects when the server does not know the serial", async () => {
    const port = await fakeAdbServer((message, socket) => {
      if (message.startsWith("host:transport:")) fail(socket, "device 'nope' not found");
    });
    process.env.ANDROID_ADB_SERVER_PORT = String(port);

    await expect(adbServerShell("nope", "true")).rejects.toThrow(/device 'nope' not found/);
  });

  it("rejects when nothing is listening, so the caller falls back to the client", async () => {
    const port = await fakeAdbServer(() => {});
    await new Promise((r) => servers.pop()!.close(r));
    process.env.ANDROID_ADB_SERVER_PORT = String(port);

    await expect(adbServerShell("emulator-5554", "true")).rejects.toThrow();
  });

  it("rejects when the server hangs past the timeout", async () => {
    const port = await fakeAdbServer(() => {});
    process.env.ANDROID_ADB_SERVER_PORT = String(port);

    await expect(adbServerShell("emulator-5554", "true", { timeoutMs: 50 })).rejects.toThrow(
      /timed out/
    );
  });

  it("rejects when the connection closes before the command was accepted", async () => {
    const port = await fakeAdbServer((message, socket) => {
      if (message.startsWith("host:transport:")) socket.write("OKAY");
      else socket.destroy();
    });
    process.env.ANDROID_ADB_SERVER_PORT = String(port);

    await expect(adbServerShell("emulator-5554", "true")).rejects.toThrow(/before answering/);
  });
});

describe("adbServerAddress", () => {
  it("defaults to the client's default server", () => {
    expect(adbServerAddress({})).toEqual({ host: "127.0.0.1", port: 5037 });
  });

  it("honours ANDROID_ADB_SERVER_PORT and ANDROID_ADB_SERVER_ADDRESS", () => {
    expect(
      adbServerAddress({ ANDROID_ADB_SERVER_PORT: "6000", ANDROID_ADB_SERVER_ADDRESS: "10.0.0.2" })
    ).toEqual({ host: "10.0.0.2", port: 6000 });
  });

  it("lets ADB_SERVER_SOCKET win, with and without a host", () => {
    expect(adbServerAddress({ ADB_SERVER_SOCKET: "tcp:localhost:5555" })).toEqual({
      host: "localhost",
      port: 5555,
    });
    expect(
      adbServerAddress({ ADB_SERVER_SOCKET: "tcp:5555", ANDROID_ADB_SERVER_PORT: "1" })
    ).toEqual({
      host: "127.0.0.1",
      port: 5555,
    });
  });

  it("ignores a malformed port rather than connecting somewhere surprising", () => {
    expect(adbServerAddress({ ANDROID_ADB_SERVER_PORT: "lots" })).toEqual({
      host: "127.0.0.1",
      port: 5037,
    });
  });
});
