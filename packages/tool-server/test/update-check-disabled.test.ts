import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import type { Registry, ToolDefinition } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { updateArgentTool } from "../src/tools/system/update-argent";
import { dismissUpdateTool } from "../src/tools/system/dismiss-update";

const echoTool: ToolDefinition<void, { ok: boolean }> = {
  id: "echo",
  description: "Echo",
  inputSchema: { type: "object", properties: {} },
  services: () => ({}),
  execute: async () => ({ ok: true }),
};

function registryWith(tools: ToolDefinition<any, any>[]): Registry {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: [...byId.keys()] })),
    getTool: vi.fn((id: string) => byId.get(id)),
    invokeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as Registry;
}

async function listedToolNames(handle: HttpAppHandle): Promise<string[]> {
  const res = await supertest(handle.app).get("/tools").expect(200);
  return res.body.tools.map((tool: { name: string }) => tool.name);
}

describe("ARGENT_DISABLE_UPDATE_CHECK", () => {
  let handle: HttpAppHandle;

  afterEach(() => {
    handle?.dispose();
    vi.unstubAllEnvs();
  });

  function startApp(): HttpAppHandle {
    handle = createHttpApp(registryWith([echoTool, updateArgentTool, dismissUpdateTool]));
    return handle;
  }

  it("lists the update tools when unset", async () => {
    vi.stubEnv("ARGENT_DISABLE_UPDATE_CHECK", undefined);
    expect(await listedToolNames(startApp())).toEqual(["echo", "update-argent", "dismiss-update"]);
  });

  it.each(["1", "true", "TRUE"])("hides the update tools when set to %s", async (value) => {
    vi.stubEnv("ARGENT_DISABLE_UPDATE_CHECK", value);
    expect(await listedToolNames(startApp())).toEqual(["echo"]);
  });

  it("keeps the update tools for other values", async () => {
    vi.stubEnv("ARGENT_DISABLE_UPDATE_CHECK", "0");
    expect(await listedToolNames(startApp())).toEqual(["echo", "update-argent", "dismiss-update"]);
  });

  it("refuses calls to the hidden update tools", async () => {
    vi.stubEnv("ARGENT_DISABLE_UPDATE_CHECK", "1");
    const app = startApp().app;
    await supertest(app).post("/tools/update-argent").send({}).expect(404);
    await supertest(app).post("/tools/dismiss-update").send({ hours: 1 }).expect(404);
  });
});
