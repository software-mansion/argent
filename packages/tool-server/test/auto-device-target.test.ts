import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { z } from "zod";
import { Registry, type ToolCapability } from "@argent/registry";
import { createHttpApp } from "../src/http";
import { createRegistry } from "../src/utils/setup-registry";

const IPHONE = "6DBF83B4-0000-4000-8000-00000000AAAA";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";

type Listed = { platform: string; state?: string; udid?: string; serial?: string; id?: string };

const iphone = (state = "Booted"): Listed => ({ platform: "ios", state, udid: IPHONE });
const android = (state = "device"): Listed => ({ platform: "android", state, serial: ANDROID });
const chromium = (): Listed => ({ platform: "chromium", state: "Running", id: CHROMIUM });

const IOS_ONLY: ToolCapability = { apple: { simulator: true } };
const CHROMIUM_ONLY: ToolCapability = { chromium: { app: true } };

/**
 * A registry holding a stub `list-devices` plus one device tool whose schema
 * requires `udid` — the shape the whole feature keys off.
 */
function harness(devices: Listed[], capability?: ToolCapability) {
  const execute = vi.fn(async (_s: unknown, params: { udid: string }) => ({ saw: params.udid }));
  const registry = new Registry();
  registry.registerTool({
    id: "list-devices",
    zodSchema: z.object({}),
    services: () => ({}),
    async execute() {
      return { devices };
    },
  });
  registry.registerTool({
    id: "poke",
    capability,
    zodSchema: z.object({ udid: z.string().describe("Target device id.") }),
    services: () => ({}),
    execute,
  });
  return { registry, execute, app: createHttpApp(registry).app };
}

describe("the advertised schema relaxes `udid` while the zod schema keeps it", () => {
  it("drops udid from the advertised required list and says why", () => {
    const { registry } = harness([]);
    const schema = registry.getTool("poke")!.inputSchema as {
      required: string[];
      properties: { udid: { description: string } };
    };
    expect(schema.required).not.toContain("udid");
    expect(schema.properties.udid.description).toContain("Target device id.");
    expect(schema.properties.udid.description).toMatch(/exactly one booted device/);
  });

  it("still refuses a udid-less call that does not come through HTTP", async () => {
    // Flows and run-sequence dispatch through invokeTool, where the zod schema
    // is authoritative. Relaxing them too would let a recorded step replay
    // against whatever happens to be booted.
    const { registry } = harness([iphone()]);
    await expect(registry.invokeTool("poke", {})).rejects.toThrow(/Invalid params/);
  });

  it("leaves a tool whose udid is already optional untouched", () => {
    // `boot-device` is the real case: no udid there means "boot by avdName",
    // so filling one in would silently change which call was made.
    const registry = new Registry();
    registry.registerTool({
      id: "opt",
      zodSchema: z.object({ udid: z.string().optional().describe("Target device id.") }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    const def = registry.getTool("opt")!;
    expect(def.autoDeviceTargetParam).toBeUndefined();
    expect(
      (def.inputSchema as { properties: { udid: { description: string } } }).properties.udid
        .description
    ).toBe("Target device id.");
  });

  it("leaves a tool that declares no udid untouched", () => {
    const registry = new Registry();
    registry.registerTool({
      id: "none",
      zodSchema: z.object({ path: z.string() }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    expect(registry.getTool("none")!.autoDeviceTargetParam).toBeUndefined();
    expect((registry.getTool("none")!.inputSchema as { required: string[] }).required).toEqual([
      "path",
    ]);
  });
});

describe("the HTTP dispatcher fills in the single booted device", () => {
  it("resolves it and hands it to execute", async () => {
    const { app, execute } = harness([iphone()]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.saw).toBe(IPHONE);
    expect(execute.mock.calls[0]![1].udid).toBe(IPHONE);
  });

  it("leaves an explicitly passed udid alone", async () => {
    const { app, execute } = harness([iphone(), android()]);
    const res = await request(app).post("/tools/poke").send({ udid: ANDROID });
    expect(res.status).toBe(200);
    expect(execute.mock.calls[0]![1].udid).toBe(ANDROID);
  });

  it("refuses when nothing is booted, listing what it saw", async () => {
    const { app, execute } = harness([iphone("Shutdown")]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No booted device supports `poke`/);
    // The listing is the point: it replaces the `list-devices` call the agent
    // would otherwise have had to make to recover.
    expect(res.body.error).toContain(IPHONE);
    expect(res.body.error).toContain("Shutdown");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous pool rather than picking one, naming the candidates", async () => {
    const { app, execute } = harness([iphone(), android()]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 booted devices support `poke`/);
    expect(res.body.error).toContain(IPHONE);
    expect(res.body.error).toContain(ANDROID);
    expect(execute).not.toHaveBeenCalled();
  });

  it("narrows a mixed pool by the tool's own capability", async () => {
    // An iPhone and a Chromium app are both booted, which is ambiguous in the
    // raw — but only one of them is a candidate for a chromium-only tool.
    const { app, execute } = harness([iphone(), chromium()], CHROMIUM_ONLY);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(200);
    expect(execute.mock.calls[0]![1].udid).toBe(CHROMIUM);
  });

  it("refuses when the only booted device is one the tool cannot drive", async () => {
    const { app } = harness([chromium()], IOS_ONLY);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No booted device supports `poke`/);
  });

  it("does not fill in for a tool whose udid is already optional", async () => {
    const registry = new Registry();
    const execute = vi.fn(async (_s: unknown, params: { udid?: string }) => ({ saw: params.udid }));
    registry.registerTool({
      id: "list-devices",
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        return { devices: [iphone()] };
      },
    });
    registry.registerTool({
      id: "opt",
      zodSchema: z.object({ udid: z.string().optional() }),
      services: () => ({}),
      execute,
    });
    const res = await request(createHttpApp(registry).app).post("/tools/opt").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.saw).toBeUndefined();
  });
});

/**
 * The set is derived from each schema rather than declared per tool, so this is
 * where a tool joining or leaving it becomes a reviewed change instead of a
 * silent one. Update the list in the same commit that changes a schema.
 */
describe("which registered tools auto-target", () => {
  const EXPECTED = [
    "await-screen-idle",
    "await-ui-element",
    "button",
    "chromium-cookies",
    "chromium-storage",
    "chromium-tabs",
    "describe",
    "gesture-custom",
    "gesture-drag",
    "gesture-pinch",
    "gesture-rotate",
    "gesture-scroll",
    "gesture-swipe",
    "gesture-tap",
    "keyboard",
    "launch-app",
    "native-describe-screen",
    "native-devtools-status",
    "native-find-views",
    "native-full-hierarchy",
    "native-network-logs",
    "native-user-interactable-view-at-point",
    "native-view-at-point",
    "open-url",
    "paste",
    "reinstall-app",
    "restart-app",
    "rotate",
    "run-sequence",
    "screen-recording-start",
    "screen-recording-stop",
    "screenshot",
    "screenshot-diff",
    "settings-permissions",
    "shake",
    "stop-simulator-server",
    "tv-remote",
  ];

  function registeredTools() {
    const registry = createRegistry();
    const ids = registry.getSnapshot().tools;
    return ids.map((id) => registry.getTool(id)!);
  }

  it("is exactly the pinned list", () => {
    const auto = registeredTools()
      .filter((def) => def.autoDeviceTargetParam !== undefined)
      .map((def) => def.id)
      .sort();
    expect(auto).toEqual(EXPECTED);
  });

  it("leaves no tool still demanding a udid it could have resolved", () => {
    // The point of deriving the set: a tool cannot end up half-in, advertising
    // `udid` as required while its 36 siblings do not.
    const stillRequired = registeredTools()
      .filter((def) =>
        ((def.inputSchema as { required?: string[] })?.required ?? []).includes("udid")
      )
      .map((def) => def.id);
    expect(stillRequired).toEqual([]);
  });

  it("never touches a `device_id` tool", () => {
    // On the debugger/profiler tools that spelling is a Metro/CDP LOGICAL id,
    // which `list-devices` does not report and a UDID cannot stand in for.
    const deviceIdTools = registeredTools().filter((def) =>
      Object.hasOwn((def.inputSchema as { properties?: object })?.properties ?? {}, "device_id")
    );
    expect(deviceIdTools.length).toBeGreaterThan(0);
    expect(deviceIdTools.filter((def) => def.autoDeviceTargetParam !== undefined)).toEqual([]);
  });
});
