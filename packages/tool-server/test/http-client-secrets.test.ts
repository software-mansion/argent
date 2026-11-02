import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import { z } from "zod";
import { CLIENT_SECRETS_HEADER, Registry, type ToolDefinition } from "@argent/registry";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import { resolveSecretPlaceholders } from "../src/utils/secrets";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    updateInstallable: false,
    installableVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

function stubRegistry(): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
    getTool: vi.fn((name: string) =>
      name === "test-tool"
        ? {
            id: "test-tool",
            description: "A stub tool for testing",
            inputSchema: { type: "object", properties: {} },
            services: () => ({}),
            execute: async () => ({}),
          }
        : undefined
    ),
    invokeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as Registry;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe(`HTTP ${CLIENT_SECRETS_HEADER} header`, () => {
  let handle: HttpAppHandle;

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("hands the decoded secrets to the tool as clientSecrets", async () => {
    const registry = stubRegistry();
    handle = createHttpApp(registry);
    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .set(CLIENT_SECRETS_HEADER, encode({ APP_PASSWORD: "hunter2\nline two" }))
      .send({});
    expect(res.status).toBe(200);
    const options = vi.mocked(registry.invokeTool).mock.calls[0]![2];
    expect(options?.clientSecrets).toEqual(new Map([["APP_PASSWORD", "hunter2\nline two"]]));
  });

  it("hands an empty header to the tool as empty clientSecrets", async () => {
    const registry = stubRegistry();
    handle = createHttpApp(registry);
    await supertest(handle.app)
      .post("/tools/test-tool")
      .set(CLIENT_SECRETS_HEADER, "e30=")
      .send({});
    expect(vi.mocked(registry.invokeTool).mock.calls[0]![2]?.clientSecrets).toEqual(new Map());
  });

  it("passes no clientSecrets without the header", async () => {
    const registry = stubRegistry();
    handle = createHttpApp(registry);
    await supertest(handle.app).post("/tools/test-tool").send({});
    expect(vi.mocked(registry.invokeTool).mock.calls[0]![2]).not.toHaveProperty("clientSecrets");
  });

  it.each([
    ["not base64 JSON", "bm90LWpzb24=", "is not base64-encoded JSON"],
    ["an array", encode(["x"]), "is not a JSON object"],
    ["an invalid name", encode({ "bad-name": "v" }), 'names an invalid secret "bad-name"'],
    ["a non-string value", encode({ PIN: 1234 }), "has a non-string value for PIN"],
  ])("rejects %s with a 400 before the tool runs", async (_label, header, reason) => {
    const registry = stubRegistry();
    handle = createHttpApp(registry);
    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .set(CLIENT_SECRETS_HEADER, header)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`The ${CLIENT_SECRETS_HEADER} header ${reason}.`);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("reaches a keyboard step of run-sequence", async () => {
    const registry = new Registry();
    const typed: string[] = [];
    registry.registerTool(createRunSequenceTool(registry));
    registry.registerTool({
      id: "keyboard",
      description: "stub",
      zodSchema: z.object({ udid: z.string(), text: z.string().optional() }),
      services: () => ({}),
      execute: async (_services, params, ctx) => {
        const options = { clientSecrets: ctx?.clientSecrets, env: {} };
        typed.push(resolveSecretPlaceholders(params.text ?? "", options).text);
        return {};
      },
    } as ToolDefinition<{ udid: string; text?: string }>);
    handle = createHttpApp(registry);
    const res = await supertest(handle.app)
      .post("/tools/run-sequence")
      .set(CLIENT_SECRETS_HEADER, encode({ ONLY_ON_CLIENT: "from-client" }))
      .send({
        udid: "chromium-cdp-9222",
        steps: [{ tool: "keyboard", args: { text: "{{secret:ONLY_ON_CLIENT}}" } }],
      });
    expect(res.status).toBe(200);
    expect(typed).toEqual(["from-client"]);
  });
});
