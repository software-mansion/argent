import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Registry, type ToolContext } from "@argent/registry";
import { z } from "zod";
import type { AddressInfo } from "node:net";
import { createHttpApp } from "../src/http";
import { deviceClaims } from "../src/utils/device-claims";
import { releaseDeviceTool } from "../src/tools/devices/release-device";

const SIM = "11111111-2222-3333-4444-555555555555";
const OTHER_SIM = "AAAAAAAA-2222-3333-4444-555555555555";

let finishHold = (): void => {};

function app() {
  const registry = new Registry();
  registry.registerTool({
    id: "hold",
    zodSchema: z.object({ udid: z.string() }),
    services: () => ({}),
    async execute() {
      await new Promise<void>((resolve) => (finishHold = resolve));
      return {};
    },
  });
  registry.registerTool({
    id: "tap",
    zodSchema: z.object({ udid: z.string() }),
    services: () => ({}),
    async execute(_services: Record<string, unknown>, _params: unknown, ctx?: ToolContext) {
      return { session: ctx?.session ?? null };
    },
  });
  registry.registerTool(releaseDeviceTool);
  return createHttpApp(registry).app;
}

function tap(server: Parameters<typeof request>[0], udid: string, session?: string) {
  const call = request(server).post("/tools/tap");
  if (session !== undefined) call.set("x-argent-session", session);
  return call.send({ udid });
}

function release(server: ReturnType<typeof app>, session: string | undefined, udid?: string) {
  const call = request(server).post("/tools/release-device");
  if (session !== undefined) call.set("x-argent-session", session);
  return call.send(udid === undefined ? {} : { udid });
}

afterEach(() => {
  vi.useRealTimers();
  for (const session of ["a", "b", "session-alpha"]) deviceClaims.release(session);
});

describe("device claims over HTTP", () => {
  it("refuses a second session on a claimed device with DEVICE_IN_USE", async () => {
    const server = app();
    const first = await tap(server, SIM, "session-alpha");
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ session: "session-alpha" });

    const second = await tap(server, SIM, "b");
    expect(second.status).toBe(409);
    expect(second.body.error_code).toBe("DEVICE_IN_USE");
    expect(second.body.error).toContain(`Device ${SIM} is in use by another Argent session`);
    expect(second.body.error).not.toContain("session-alpha");

    expect((await tap(server, OTHER_SIM, "b")).status).toBe(200);
    expect((await tap(server, SIM, "session-alpha")).status).toBe(200);
  });

  it("frees a device 10 minutes after the last call of its session ended", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = app();
    await tap(server, SIM, "a");
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(10 * 60_000);
    expect((await tap(server, SIM, "b")).status).toBe(409);
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect((await tap(server, SIM, "b")).status).toBe(200);
  });

  it("lets a caller without a session drive a claimed device and claims nothing for it", async () => {
    const server = app();
    expect((await tap(server, SIM)).status).toBe(200);
    expect((await tap(server, SIM, "a")).status).toBe(200);
    const anonymous = await tap(server, SIM);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.data).toEqual({ session: null });
  });

  it("frees the device for another session after release-device", async () => {
    const server = app();
    await tap(server, SIM, "a");
    await tap(server, OTHER_SIM, "a");

    const releasedOne = await release(server, "a", SIM);
    expect(releasedOne.body.data).toEqual({ released: [SIM] });
    expect((await release(server, "a", SIM)).body.data).toEqual({ released: [] });
    expect((await tap(server, SIM, "b")).status).toBe(200);
    expect((await tap(server, OTHER_SIM, "b")).status).toBe(409);

    expect((await release(server, "a")).body.data).toEqual({ released: [OTHER_SIM] });
    expect((await tap(server, OTHER_SIM, "b")).status).toBe(200);
  });

  it("does not let release-device free another session's claim", async () => {
    const server = app();
    await tap(server, SIM, "a");
    const res = await release(server, "b", SIM);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ released: [] });
    expect((await tap(server, SIM, "b")).status).toBe(409);
  });

  it("keeps the device claimed until a cancelled call has stopped", async () => {
    const server = app().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const abort = new AbortController();
    const held = fetch(`http://127.0.0.1:${port}/tools/hold`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-argent-session": "a" },
      body: JSON.stringify({ udid: SIM }),
      signal: abort.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(deviceClaims.ownerOf(SIM, "a")).toBe("this session"));
    abort.abort();
    await held;
    await new Promise((resolve) => setImmediate(resolve));

    deviceClaims.release("a");
    expect((await tap(server, SIM, "b")).status).toBe(409);
    finishHold();
    await vi.waitFor(async () => expect((await tap(server, SIM, "b")).status).toBe(200));
    server.close();
  });

  it("refuses release-device with an unknown key and keeps every claim", async () => {
    const server = app();
    await tap(server, SIM, "a");
    await tap(server, OTHER_SIM, "a");

    const res = await request(server)
      .post("/tools/release-device")
      .set("x-argent-session", "a")
      .send({ device_id: SIM });
    expect(res.status).toBe(400);
    expect((await tap(server, SIM, "b")).status).toBe(409);
    expect((await tap(server, OTHER_SIM, "b")).status).toBe(409);
  });

  it("matches a physical iPhone UDID in any case", async () => {
    const server = app();
    await tap(server, "00008110-001A2B3C4D5E801E", "a");
    expect((await tap(server, "00008110-001a2b3c4d5e801e", "b")).status).toBe(409);
    expect((await release(server, "a", "00008110-001a2b3c4d5e801e")).body.data).toEqual({
      released: ["00008110-001A2B3C4D5E801E"],
    });
  });

  it("asks for a session when release-device has none", async () => {
    const res = await release(app(), undefined);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("ARGENT_SESSION");
  });

  it("refuses a malformed session header", async () => {
    const res = await tap(app(), SIM, "two words");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-argent-session");
  });
});
