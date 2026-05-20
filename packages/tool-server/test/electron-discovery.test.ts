import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  discoverElectronDevices,
  getCandidateElectronPorts,
  trackElectronPort,
  untrackElectronPort,
} from "../src/utils/electron-discovery";

interface FakeCdpServer {
  port: number;
  close: () => Promise<void>;
}

async function startFakeCdpServer(options?: {
  responses?: {
    version?: number | object;
    list?: number | object;
  };
}): Promise<FakeCdpServer> {
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      const r = options?.responses?.version ?? {
        Browser: "Chrome/148.0.7778.97",
        webSocketDebuggerUrl: `ws://127.0.0.1:0/devtools/browser/x`,
      };
      if (typeof r === "number") {
        res.statusCode = r;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r));
      return;
    }
    if (req.url === "/json/list") {
      const r = options?.responses?.list ?? [
        {
          id: "abc",
          type: "page",
          title: "Test Page",
          url: "file:///tmp/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:0/devtools/page/abc`,
        },
      ];
      if (typeof r === "number") {
        res.statusCode = r;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const portsToCleanup: number[] = [];
const serversToCleanup: FakeCdpServer[] = [];

afterEach(async () => {
  for (const p of portsToCleanup.splice(0)) untrackElectronPort(p);
  for (const s of serversToCleanup.splice(0)) await s.close();
});

describe("getCandidateElectronPorts", () => {
  it("always includes 9222", () => {
    const ports = getCandidateElectronPorts();
    expect(ports).toContain(9222);
  });

  it("includes tracked ports added via trackElectronPort", () => {
    trackElectronPort(54321);
    portsToCleanup.push(54321);
    expect(getCandidateElectronPorts()).toContain(54321);
  });

  it("removes tracked ports via untrackElectronPort", () => {
    trackElectronPort(54322);
    expect(getCandidateElectronPorts()).toContain(54322);
    untrackElectronPort(54322);
    expect(getCandidateElectronPorts()).not.toContain(54322);
  });
});

describe("discoverElectronDevices", () => {
  it("finds a fake CDP endpoint when its port is tracked", async () => {
    const server = await startFakeCdpServer();
    serversToCleanup.push(server);
    trackElectronPort(server.port);
    portsToCleanup.push(server.port);

    const devices = await discoverElectronDevices({ timeoutMs: 1500 });
    const ours = devices.find((d) => d.port === server.port);
    expect(ours).toBeDefined();
    expect(ours?.platform).toBe("electron");
    expect(ours?.id).toBe(`electron-cdp-${server.port}`);
    expect(ours?.title).toBe("Test Page");
    expect(ours?.url).toBe("file:///tmp/index.html");
    expect(ours?.browser).toMatch(/Chrome/);
    expect(ours?.state).toBe("Running");
  });

  it("returns no entry for a non-responsive port", async () => {
    // Tracked but no server bound
    trackElectronPort(1);
    portsToCleanup.push(1);
    const devices = await discoverElectronDevices({ timeoutMs: 300, ports: [1] });
    expect(devices).toEqual([]);
  });

  it("filters out ports with no page targets", async () => {
    const server = await startFakeCdpServer({
      responses: {
        list: [
          { id: "x", type: "service_worker", title: "", url: "", webSocketDebuggerUrl: "ws://x" },
        ],
      },
    });
    serversToCleanup.push(server);
    const devices = await discoverElectronDevices({ timeoutMs: 1500, ports: [server.port] });
    expect(devices).toEqual([]);
  });

  it("untracks a port after it stops responding", async () => {
    const server = await startFakeCdpServer();
    trackElectronPort(server.port);
    portsToCleanup.push(server.port);

    // First probe succeeds — port stays tracked.
    let devices = await discoverElectronDevices({ timeoutMs: 1500 });
    expect(devices.some((d) => d.port === server.port)).toBe(true);

    // Close the server, probe again — port should be untracked.
    await server.close();
    devices = await discoverElectronDevices({ timeoutMs: 300 });
    expect(devices.some((d) => d.port === server.port)).toBe(false);
    expect(getCandidateElectronPorts()).not.toContain(server.port);
  });
});
