import { beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
const materializeArtifacts = vi.fn();

vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/tools-client")>();
  return {
    ...actual,
    createToolsClient: () => ({
      fetchTools: async () => [
        { name: "describe", description: "d", inputSchema: {}, fileInputs: [], alwaysLoad: true },
      ],
      callTool,
      baseUrl: async () => ({ url: "http://127.0.0.1:1", token: "t" }),
    }),
    materializeArtifacts,
  };
});

const { ToolInvocationError } = await import("@argent/tools-client");
const { createArgentClient, ArgentToolError } = await import("../src/client.js");

beforeEach(() => {
  callTool.mockReset();
  materializeArtifacts.mockReset();
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
});
