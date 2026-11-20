import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunnerCommandSender } from "../src/utils/ios-device/runner-route";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    })
  );
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "::1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

describe("CoreDevice runner transport over IPv6 TCP", () => {
  it("sends a command through the tunnel without opening usbmux", async () => {
    let authorization: string | undefined;
    let body = "";
    const port = await listen((request, response) => {
      authorization = request.headers.authorization;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        response.end(JSON.stringify({ ok: true, data: { ready: true } }));
      });
    });
    const sendViaUsbmux = vi.fn();
    const sender = createRunnerCommandSender({ tunnelAddress: "::1", sendViaUsbmux });
    await expect(
      sender.sendCommand(
        "phone",
        port,
        { command: "status" },
        {
          timeoutMs: 2000,
          readOnly: true,
        }
      )
    ).resolves.toEqual({ ok: true, data: { ready: true } });
    expect(authorization).toBeUndefined();
    expect(JSON.parse(body)).toEqual({ command: "status" });
    expect(sendViaUsbmux).not.toHaveBeenCalled();
  });

  it("does not replay a mutation after the tunnel drops its reply", async () => {
    let calls = 0;
    const port = await listen((request) => {
      calls += 1;
      request.socket.destroy();
    });
    const sender = createRunnerCommandSender({
      tunnelAddress: "::1",
    });
    await expect(
      sender.sendCommand("phone", port, { command: "tap" }, { timeoutMs: 2000 })
    ).rejects.toMatchObject({ kind: "http" });
    expect(calls).toBe(1);
  });
});
