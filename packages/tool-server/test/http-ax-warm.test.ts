import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

const tvOs = vi.hoisted(() => ({ udids: new Set<string>() }));
vi.mock("../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async (udid: string) => tvOs.udids.has(udid)),
}));

const TOKEN = "abc123def456";
const SIM = "A1B2C3D4-0000-4000-8000-000000000001";

describe("POST /ax-service/:udid/warm", () => {
  let handle: HttpAppHandle;
  let describeScreen: ReturnType<typeof vi.fn>;
  let resolveService: ReturnType<typeof vi.fn>;
  let invokeTool: ReturnType<typeof vi.fn>;
  let originalToken: string | undefined;

  const warm = (udid: string) =>
    supertest(handle.app)
      .post(`/ax-service/${encodeURIComponent(udid)}/warm`)
      .set("Authorization", `Bearer ${TOKEN}`);

  beforeEach(() => {
    originalToken = process.env.ARGENT_AUTH_TOKEN;
    process.env.ARGENT_AUTH_TOKEN = TOKEN;
    describeScreen = vi.fn(async () => ({ alertVisible: false, elements: [] }));
    resolveService = vi.fn(async () => ({ degraded: false, describe: describeScreen }));
    invokeTool = vi.fn();
    handle = createHttpApp({
      getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: [] })),
      getTool: vi.fn(() => undefined),
      invokeTool,
      resolveService,
    } as unknown as Registry);
  });

  afterEach(() => {
    handle.dispose();
    tvOs.udids.clear();
    if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
    else process.env.ARGENT_AUTH_TOKEN = originalToken;
  });

  it("starts a simulator's ax-service and reads once, without invoking a tool", async () => {
    const res = await warm(SIM);

    expect(res.status).toBe(204);
    expect(resolveService).toHaveBeenCalledWith(`AXService:${SIM}`, expect.anything());
    expect(describeScreen).toHaveBeenCalledTimes(1);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it.each([
    ["an Android emulator", "emulator-5554"],
    ["a physical iPhone", "00008110-000978540290401E"],
    ["a Vega device", "amazon-abc123"],
    ["an attached simulator", `ext:prov:${SIM}`],
    ["a remote simulator", `remote:${SIM}`],
  ])("refuses %s", async (_label, udid) => {
    const res = await warm(udid);

    expect(res.status).toBe(400);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("refuses a tvOS simulator", async () => {
    tvOs.udids.add(SIM);

    const res = await warm(SIM);

    expect(res.status).toBe(400);
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("reports a reader that fails to start", async () => {
    resolveService.mockRejectedValueOnce(new Error("Invalid device"));

    const res = await warm(SIM);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Invalid device");
  });

  it("requires the auth token", async () => {
    const res = await supertest(handle.app).post(`/ax-service/${SIM}/warm`);

    expect(res.status).toBe(401);
  });
});
