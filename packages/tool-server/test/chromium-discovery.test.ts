import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import {
  discoverChromiumDevices,
  getCandidateChromiumPorts,
  trackChromiumPort,
  untrackChromiumPort,
} from "../src/utils/chromium-discovery";

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

// Redirect port persistence to a throwaway file so tests never touch the
// real ~/.argent/chromium-cdp-ports.json on a developer machine or CI runner.
const TEST_PORTS_FILE = path.join(os.tmpdir(), `argent-test-chromium-ports-${process.pid}.json`);

beforeAll(() => {
  process.env.ARGENT_CHROMIUM_PORTS_FILE = TEST_PORTS_FILE;
});

afterAll(() => {
  delete process.env.ARGENT_CHROMIUM_PORTS_FILE;
  try {
    fs.unlinkSync(TEST_PORTS_FILE);
  } catch {
    // never created — fine
  }
});

afterEach(async () => {
  for (const p of portsToCleanup.splice(0)) untrackChromiumPort(p);
  for (const s of serversToCleanup.splice(0)) await s.close();
});

describe("getCandidateChromiumPorts", () => {
  it("always includes 9222", () => {
    const ports = getCandidateChromiumPorts();
    expect(ports).toContain(9222);
  });

  it("includes tracked ports added via trackChromiumPort", () => {
    trackChromiumPort(54321);
    portsToCleanup.push(54321);
    expect(getCandidateChromiumPorts()).toContain(54321);
  });

  it("removes tracked ports via untrackChromiumPort", () => {
    trackChromiumPort(54322);
    expect(getCandidateChromiumPorts()).toContain(54322);
    untrackChromiumPort(54322);
    expect(getCandidateChromiumPorts()).not.toContain(54322);
  });
});

describe("discoverChromiumDevices", () => {
  it("finds a fake CDP endpoint when its port is tracked", async () => {
    const server = await startFakeCdpServer();
    serversToCleanup.push(server);
    trackChromiumPort(server.port);
    portsToCleanup.push(server.port);

    const devices = await discoverChromiumDevices({ timeoutMs: 1500 });
    const ours = devices.find((d) => d.port === server.port);
    expect(ours).toBeDefined();
    expect(ours?.platform).toBe("chromium");
    expect(ours?.id).toBe(`chromium-cdp-${server.port}`);
    expect(ours?.title).toBe("Test Page");
    expect(ours?.url).toBe("file:///tmp/index.html");
    expect(ours?.browser).toMatch(/Chrome/);
    expect(ours?.state).toBe("Running");
  });

  it("returns no entry for a non-responsive port", async () => {
    // Tracked but no server bound
    trackChromiumPort(1);
    portsToCleanup.push(1);
    const devices = await discoverChromiumDevices({ timeoutMs: 300, ports: [1] });
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
    const devices = await discoverChromiumDevices({ timeoutMs: 1500, ports: [server.port] });
    expect(devices).toEqual([]);
  });

  it("untracks a port after it stops responding", async () => {
    const server = await startFakeCdpServer();
    trackChromiumPort(server.port);
    portsToCleanup.push(server.port);

    // First probe succeeds — port stays tracked.
    let devices = await discoverChromiumDevices({ timeoutMs: 1500 });
    expect(devices.some((d) => d.port === server.port)).toBe(true);

    // Close the server, probe again — port should be untracked.
    await server.close();
    devices = await discoverChromiumDevices({ timeoutMs: 300 });
    expect(devices.some((d) => d.port === server.port)).toBe(false);
    expect(getCandidateChromiumPorts()).not.toContain(server.port);
  });
});

describe("port persistence across tool-server restarts", () => {
  // Booted Chromium apps are detached and outlive the tool-server (which
  // auto-exits on idle). A fresh module instance — same as a fresh process —
  // must rediscover them from the persisted file.
  it("a fresh module instance sees ports tracked by a previous one", async () => {
    trackChromiumPort(43210);
    portsToCleanup.push(43210);

    vi.resetModules();
    const fresh = await import("../src/utils/chromium-discovery");
    expect(fresh.getCandidateChromiumPorts()).toContain(43210);
  });

  it("a dead persisted port is pruned from the file after a failed probe", async () => {
    trackChromiumPort(43211);
    portsToCleanup.push(43211);
    expect(JSON.parse(fs.readFileSync(TEST_PORTS_FILE, "utf8"))).toContain(43211);

    // Nothing listens on 43211 — the probe fails and prunes it everywhere.
    await discoverChromiumDevices({ timeoutMs: 300, ports: [43211] });
    expect(JSON.parse(fs.readFileSync(TEST_PORTS_FILE, "utf8"))).not.toContain(43211);
    expect(getCandidateChromiumPorts()).not.toContain(43211);
  });

  it("untrackChromiumPort removes the port from the persisted file", () => {
    trackChromiumPort(43212);
    expect(JSON.parse(fs.readFileSync(TEST_PORTS_FILE, "utf8"))).toContain(43212);
    untrackChromiumPort(43212);
    expect(JSON.parse(fs.readFileSync(TEST_PORTS_FILE, "utf8"))).not.toContain(43212);
  });

  it("ignores a corrupt persistence file", () => {
    fs.writeFileSync(TEST_PORTS_FILE, "not json{{{");
    expect(() => getCandidateChromiumPorts()).not.toThrow();
    expect(getCandidateChromiumPorts()).toContain(9222);
    // Tracking after corruption rewrites the file cleanly.
    trackChromiumPort(43213);
    portsToCleanup.push(43213);
    expect(JSON.parse(fs.readFileSync(TEST_PORTS_FILE, "utf8"))).toContain(43213);
  });
});
