import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Registry, type ToolContext } from "@argent/registry";
import { z } from "zod";
import { createHttpApp } from "../src/http";
import { deviceClaims } from "../src/utils/device-claims";
import { releaseDeviceTool } from "../src/tools/devices/release-device";

const SIM = "11111111-2222-3333-4444-555555555555";
const OTHER_SIM = "AAAAAAAA-2222-3333-4444-555555555555";

function app() {
  const registry = new Registry();
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

function tap(server: ReturnType<typeof app>, udid: string, session?: string) {
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
  deviceClaims.release("a");
  deviceClaims.release("b");
});

describe("device claims over HTTP", () => {
  it("refuses a second session on a claimed device with DEVICE_IN_USE", async () => {
    const server = app();
    const first = await tap(server, SIM, "a");
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ session: "a" });

    const second = await tap(server, SIM, "b");
    expect(second.status).toBe(409);
    expect(second.body.error_code).toBe("DEVICE_IN_USE");
    expect(second.body.error).toContain(`Device ${SIM} is in use by another Argent session`);
    expect(second.body.error).not.toContain('"a"');

    expect((await tap(server, OTHER_SIM, "b")).status).toBe(200);
    expect((await tap(server, SIM, "a")).status).toBe(200);
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
