import { beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
const materializeArtifacts = vi.fn();
const createToolsClient = vi.fn();
const killToolServer = vi.fn();
const readToolsServerState = vi.fn();

vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/tools-client")>();
  return {
    ...actual,
    createToolsClient,
    materializeArtifacts,
    killToolServer,
    readToolsServerState,
  };
});

vi.mock("@argent/configuration-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/configuration-core")>();
  return {
    ...actual,
    FLAG_REGISTRY: [
      { name: "on-flag", description: "a" },
      { name: "off-flag", description: "b" },
    ],
    isFeatureEnabled: (name: string) => name === "on-flag",
  };
});

const { ToolInvocationError } = await import("@argent/tools-client");
const { createArgentClient, ArgentToolError, listFlags } = await import("../src/client.js");

beforeEach(() => {
  callTool.mockReset();
  materializeArtifacts.mockReset();
  killToolServer.mockReset();
  readToolsServerState.mockReset();
  createToolsClient.mockReset().mockImplementation(() => ({
    fetchTools: async () => [
      { name: "describe", description: "d", inputSchema: {}, fileInputs: [], alwaysLoad: true },
    ],
    callTool,
    baseUrl: async () => ({ url: "http://127.0.0.1:1", token: "t" }),
  }));
});

describe("createArgentClient", () => {
  it("lists only the public tool fields", async () => {
    expect(await createArgentClient().listTools()).toEqual([
      { name: "describe", description: "d", inputSchema: {} },
    ]);
  });

  it("returns the materialized result and forwards the device id", async () => {
    callTool.mockResolvedValue({ data: { image: "handle" }, note: "n" });
    materializeArtifacts.mockResolvedValue({ result: { image: "/tmp/shot.png" }, images: [] });

    const result = await createArgentClient().callTool("screenshot", { udid: "U1" });

    expect(result).toEqual({ data: { image: "/tmp/shot.png" }, note: "n" });
    expect(materializeArtifacts).toHaveBeenCalledWith(
      { image: "handle" },
      { toolsUrl: "http://127.0.0.1:1", authToken: "t", deviceId: "U1" }
    );
  });

  it("rethrows a tool-server failure as ArgentToolError", async () => {
    callTool.mockRejectedValue(
      new ToolInvocationError("bad", { errorCode: "C", errorKind: "validation", issues: [1] })
    );

    const error = await createArgentClient()
      .callTool("describe")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ArgentToolError);
    expect(error).toMatchObject({ message: "bad", code: "C", kind: "validation", issues: [1] });
  });

  it("forwards the abort signal", async () => {
    callTool.mockResolvedValue({ data: {} });
    materializeArtifacts.mockResolvedValue({ result: {}, images: [] });
    const { signal } = new AbortController();

    await createArgentClient().callTool("describe", {}, { signal });

    expect(callTool).toHaveBeenCalledWith("describe", {}, { signal });
  });

  it("passes an abort through unwrapped and skips materialization", async () => {
    const controller = new AbortController();
    const reason = new Error("gave up");
    // The reply lands, then the caller aborts before the artifacts are read.
    callTool.mockImplementation(async () => {
      controller.abort(reason);
      return { data: { image: "handle" } };
    });

    const error = await createArgentClient()
      .callTool("screenshot", {}, { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(materializeArtifacts).not.toHaveBeenCalled();
  });

  it("stops its own tool-server and reconnects on the next call", async () => {
    readToolsServerState.mockResolvedValue({ pid: 1 });
    const argent = createArgentClient();

    expect(await argent.stopServer()).toBe(true);
    expect(killToolServer).toHaveBeenCalledWith(expect.stringMatching(/tool-server\.cjs$/));
    // A fresh tools client, so the next call does not reuse the stopped server.
    expect(createToolsClient).toHaveBeenCalledTimes(2);

    readToolsServerState.mockResolvedValue(null);
    expect(await argent.stopServer()).toBe(false);
  });
});

describe("listFlags", () => {
  it("reports every registry flag with its effective state", () => {
    expect(listFlags()).toEqual([
      { name: "on-flag", description: "a", enabled: true },
      { name: "off-flag", description: "b", enabled: false },
    ]);
  });
});
