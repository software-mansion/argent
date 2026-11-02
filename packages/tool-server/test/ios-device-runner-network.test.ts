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
  it("sends the session bearer token without opening usbmux", async () => {
    const token = "a".repeat(64);
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
    const sender = createRunnerCommandSender({ network: { address: "::1", token }, sendViaUsbmux });
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
    expect(authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(body)).toEqual({ command: "status" });
    expect(sendViaUsbmux).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not retry an authorization failure (readOnly=%s)",
    async (readOnly) => {
      let calls = 0;
      const port = await listen((_request, response) => {
        calls += 1;
        response.writeHead(401);
        response.end(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED" } }));
      });
      const sender = createRunnerCommandSender({
        network: { address: "::1", token: "b".repeat(64) },
      });
      await expect(
        sender.sendCommand(
          "phone",
          port,
          { command: "tap" },
          {
            timeoutMs: 2000,
            readOnly,
          }
        )
      ).rejects.toMatchObject({
        kind: "protocol",
        retryable: false,
        message: "Runner session authorization failed",
      });
      expect(calls).toBe(1);
    }
  );

  it("does not replay a mutation after the tunnel drops its reply", async () => {
    let calls = 0;
    const port = await listen((request) => {
      calls += 1;
      request.socket.destroy();
    });
    const sender = createRunnerCommandSender({
      network: { address: "::1", token: "c".repeat(64) },
    });
    await expect(
      sender.sendCommand("phone", port, { command: "tap" }, { timeoutMs: 2000 })
    ).rejects.toMatchObject({ kind: "http" });
    expect(calls).toBe(1);
  });
});
