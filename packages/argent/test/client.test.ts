import { beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
const materializeArtifacts = vi.fn();
const createToolsClient = vi.fn();
const killToolServer = vi.fn();

vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/tools-client")>();
  return {
    ...actual,
    createToolsClient,
    materializeArtifacts,
    killToolServer,
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
      { toolsUrl: "http://127.0.0.1:1", authToken: "t", deviceId: "U1", signal: undefined }
    );
  });

  it("forwards the signal to the artifact download and throws when it aborts there", async () => {
    const controller = new AbortController();
    const reason = new Error("gave up");
    callTool.mockResolvedValue({ data: { video: "handle" } });
    // The abort lands mid-download, which reads the artifact as missing.
    materializeArtifacts.mockImplementation(async (_data, ctx: { signal?: AbortSignal }) => {
      expect(ctx.signal).toBe(controller.signal);
      controller.abort(reason);
      return { result: { video: null }, images: [] };
    });

    const error = await createArgentClient()
      .callTool("screen-recording-stop", { udid: "U1" }, { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(error).toBe(reason);
  });

  it("rethrows a tool-server failure as ArgentToolError", async () => {
    callTool.mockRejectedValue(
      new ToolInvocationError("bad", { errorCode: "C", errorKind: "validation", issues: [1] })
    );

    const error = await createArgentClient()
      .callTool("list-devices")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ArgentToolError);
    expect(error).toMatchObject({ message: "bad", code: "C", kind: "validation", issues: [1] });
  });

  it("forwards the abort signal of listTools", async () => {
    const fetchTools = vi.fn(async () => []);
    createToolsClient.mockImplementation(() => ({ fetchTools, callTool }));
    const { signal } = new AbortController();

    await createArgentClient().listTools({ signal });

    expect(fetchTools).toHaveBeenCalledWith({ signal });
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
      .callTool("screenshot", { udid: "U1" }, { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(materializeArtifacts).not.toHaveBeenCalled();
  });

  it("stops its own tool-server and reconnects on the next call", async () => {
    killToolServer.mockResolvedValue(true);
    const argent = createArgentClient();

    expect(await argent.stopServer()).toBe(true);
    expect(killToolServer).toHaveBeenCalledWith(expect.stringMatching(/tool-server\.cjs$/));
    // A fresh tools client, so the next call does not reuse the stopped server.
    expect(createToolsClient).toHaveBeenCalledTimes(2);

    killToolServer.mockResolvedValue(false);
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
