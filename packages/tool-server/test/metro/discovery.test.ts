import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFailureSignal, FAILURE_CODES } from "@argent/registry";
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

  it("tolerates a missing project root header (RN 0.72 / Vega Metro never sends it)", async () => {
    const targets = [
      {
        id: "page1",
        title: "Hermes React Native",
        description: "com.example.vega",
        webSocketDebuggerUrl: "ws://localhost:8081/inspector/debug?device=0&page=1",
        deviceName: "kepler-device",
      },
    ];

    mockFetch
      .mockResolvedValueOnce(new Response("packager-status:running"))
      .mockResolvedValueOnce(targetsResponse(targets));

    // Only source-map / file:line resolution needs projectRoot, so discovery
    // degrades to "" instead of taking the whole debugger session down.
    const info = await discoverMetro(8081);
    expect(info.projectRoot).toBe("");
    expect(info.targets).toHaveLength(1);
  });

  // Metro dying BETWEEN probes: every network read in the sequence must land
  // on the same classified failure as the initial connect — an unclassified
  // fetch/stream error here surfaces as an opaque 500 that debugger-status /
  // debugger-log-registry cannot map to a structured result.
  describe("mid-sequence connection loss classifies as METRO_NOT_RUNNING", () => {
    it("socket dies while reading the /status body", async () => {
      const dyingBody = new ReadableStream({
        start(controller) {
          controller.error(new TypeError("terminated: other side closed"));
        },
      });
      mockFetch.mockResolvedValueOnce(new Response(dyingBody));
      let thrown: unknown;
      try {
        await discoverMetro(8081);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toMatch(/^Metro at port 8081 is not running \(got: /);
      expect((thrown as Error).message).toContain("Do not retry in a loop");
      expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING);
    });

    it("socket dies on the /json/list fetch", async () => {
      mockFetch
        .mockResolvedValueOnce(statusResponse("/Users/dev/myapp"))
        .mockRejectedValueOnce(new TypeError("fetch failed"));
      let thrown: unknown;
      try {
        await discoverMetro(8081);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toMatch(/^Metro at port 8081 is not running \(got: /);
      expect((thrown as Error).message).toContain("Do not retry in a loop");
      expect(getFailureSignal(thrown)?.error_code).toBe(FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING);
    });
  });

  it("throws when no targets are found", async () => {
    mockFetch
      .mockResolvedValueOnce(statusResponse("/Users/dev/myapp"))
      .mockResolvedValueOnce(targetsResponse([]));
    await expect(discoverMetro(8081)).rejects.toThrow("no CDP targets");
  });

  // Anti-retry-storm guidance: the original first sentences are contract
  // (agents and skills match on them) and the appended guidance must tell the
  // agent explicitly not to loop.
  describe("guidance sentences", () => {
    async function rejection(p: Promise<unknown>): Promise<Error> {
      try {
        await p;
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected discoverMetro to reject");
    }

    it("nothing listening: keeps the first sentence and appends the no-retry-loop guidance", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
      const err = await rejection(discoverMetro(8081));
      expect(err.message).toMatch(/^Metro at port 8081 is not running \(got: fetch failed\)\./);
      expect(err.message).toContain(
        "Do not retry in a loop — the result will not change until Metro is started."
      );
      expect(err.message).toContain("`npx react-native start` or `npx expo start`");
      expect(err.message).toContain("wait for it to report ready, then retry once");
    });

    it("non-Metro responder: appends the find-the-right-port guidance", async () => {
      mockFetch.mockResolvedValueOnce(new Response("<html>hello</html>"));
      const err = await rejection(discoverMetro(8081));
      expect(err.message).toMatch(/^Metro at port 8081 is not running \(got: /);
      expect(err.message).toContain("Something else is listening on this port");
      expect(err.message).toContain("Do not retry in a loop");
      expect(err.message).toContain("find the port Metro actually runs on");
    });

    it("no targets: keeps the first sentence and appends launch-app + Android reverse-proxy guidance", async () => {
      mockFetch
        .mockResolvedValueOnce(statusResponse("/Users/dev/myapp"))
        .mockResolvedValueOnce(targetsResponse([]));
      const err = await rejection(discoverMetro(8081));
      expect(err.message).toMatch(
        /^Metro at port 8081 has no CDP targets — is a React Native app connected\?/
      );
      expect(err.message).toContain(
        "Do not retry immediately — this will not change until an app attaches."
      );
      expect(err.message).toContain("launch-app / restart-app");
      expect(err.message).toContain("wait a few seconds for the bundle to load, then retry once");
      expect(err.message).toContain("a missing port reverse-proxy is the most common cause");
      expect(err.message).toContain("metro-debugger skill's Android prerequisites");
    });
  });
});
