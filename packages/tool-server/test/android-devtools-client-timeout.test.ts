import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { connectAndroidDevtoolsClient } from "../src/utils/android-devtools-client";

// A helper that reads requests and never answers.
const servers: net.Server[] = [];
async function silentHelper(): Promise<number> {
  const server = net.createServer((socket) => socket.on("data", () => {}));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
});

describe("android-devtools client RPC timeouts", () => {
  it("gives setText longer than the default, past the helper's own 12 s worker timeout", async () => {
    const client = await connectAndroidDevtoolsClient(await silentHelper(), () => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const request = client.request("setText", { text: "x" }).catch((err: unknown) => {
      settled = true;
      return err;
    });
    await vi.advanceTimersByTimeAsync(12_500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await request;
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.ANDROID_DEVTOOLS_RPC_TIMEOUT);
    client.close();
  });

  it("keeps the 5 s default for other methods", async () => {
    const client = await connectAndroidDevtoolsClient(await silentHelper(), () => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = client.request("ping").catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(getFailureSignal(await request)?.error_code).toBe(
      FAILURE_CODES.ANDROID_DEVTOOLS_RPC_TIMEOUT
    );
    client.close();
  });
});
