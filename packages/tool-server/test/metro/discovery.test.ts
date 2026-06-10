import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverMetro } from "../../src/utils/debugger/discovery";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function statusResponse(projectRoot: string) {
  return new Response("packager-status:running", {
    headers: { "X-React-Native-Project-Root": projectRoot },
  });
}

function targetsResponse(targets: unknown[]) {
  return new Response(JSON.stringify(targets), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("discoverMetro", () => {
  it("discovers a running Metro server", async () => {
    const targets = [
      {
        id: "page1",
        title: "React Native",
        description: "some desc",
        webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=0&page=1",
        deviceName: "iPhone 16",
      },
    ];

    mockFetch
      .mockResolvedValueOnce(statusResponse("/Users/dev/myapp"))
      .mockResolvedValueOnce(targetsResponse(targets));

    const info = await discoverMetro(8081);
    expect(info.port).toBe(8081);
    expect(info.projectRoot).toBe("/Users/dev/myapp");
    expect(info.targets).toHaveLength(1);
    expect(info.targets[0].id).toBe("page1");
  });

  it("throws when Metro is not running", async () => {
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    await expect(discoverMetro(8081)).rejects.toThrow("not running");
  });

  it("falls back to cwd when the project root header is missing (forked Metro, e.g. Vega)", async () => {
    const targets = [
      {
        id: "0-1",
        title: "Hermes React Native",
        description: "com.example.app",
        webSocketDebuggerUrl: "ws://[::1]:8081/inspector/debug?device=0&page=1",
        deviceName: "kepler-device",
      },
    ];
    mockFetch
      .mockResolvedValueOnce(new Response("packager-status:running"))
      .mockResolvedValueOnce(targetsResponse(targets));

    const info = await discoverMetro(8081);
    expect(info.projectRoot).toBe(process.cwd());
    expect(info.targets).toHaveLength(1);
    expect(info.targets[0].id).toBe("0-1");
  });

  it("throws when no targets are found", async () => {
    mockFetch
      .mockResolvedValueOnce(statusResponse("/Users/dev/myapp"))
      .mockResolvedValueOnce(targetsResponse([]));
    await expect(discoverMetro(8081)).rejects.toThrow("no CDP targets");
  });
});
