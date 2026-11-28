import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { probeArgentToolServer } from "../src/utils/probe-argent-tool-server";
import { ARGENT_HOME_HEADER, argentHomeId, isLocalConnection } from "../src/utils/argent-home-id";

// Bind an ephemeral loopback server with a given handler; returns its port.
function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, server });
    });
  });
}

const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("probeArgentToolServer", () => {
  it("returns true for an argent peer answering /tools with 200", async () => {
    const { port, server } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: [] }));
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(true);
  });

  it("returns true for a token-protected peer answering /tools with 401", async () => {
    const { port, server } = await listen((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid Authorization header." }));
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(true);
  });

  it("returns false for a foreign server answering with a non-argent status (500)", async () => {
    const { port, server } = await listen((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(false);
  });

  it("returns false when nothing is listening (connection refused)", async () => {
    // Grab a port then immediately release it so the connection is refused.
    const { port, server } = await listen((_req, res) => res.end());
    await new Promise<void>((r) => server.close(() => r()));
    await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(false);
  });

  it("returns false when the peer accepts but never responds (wedged) before the timeout", async () => {
    const { port, server } = await listen(() => {
      /* accept the request but never write a response → probe must time out */
    });
    servers.push(server);
    await expect(probeArgentToolServer("127.0.0.1", port, 150)).resolves.toBe(false);
  });

  describe("with several Argent homes", () => {
    const relocated = path.join(os.tmpdir(), "argent-probe-relocated");

    async function peerWithHeader(home: string | null): Promise<number> {
      const { port, server } = await listen((_req, res) => {
        res.writeHead(401, home === null ? {} : { [ARGENT_HOME_HEADER]: home });
        res.end();
      });
      servers.push(server);
      return port;
    }

    it("defers to a peer that names the same Argent home", async () => {
      vi.stubEnv("ARGENT_HOME_DIR", relocated);
      const port = await peerWithHeader(argentHomeId(relocated));
      await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(true);
    });

    it("does not defer to a peer under another Argent home", async () => {
      vi.stubEnv("ARGENT_HOME_DIR", relocated);
      const port = await peerWithHeader(argentHomeId(path.join(os.homedir(), ".argent")));
      await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(false);
    });

    it("treats a peer without the header as one under ~/.argent", async () => {
      const port = await peerWithHeader(null);
      vi.stubEnv("ARGENT_HOME_DIR", "");
      await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(true);
      vi.stubEnv("ARGENT_HOME_DIR", relocated);
      await expect(probeArgentToolServer("127.0.0.1", port)).resolves.toBe(false);
    });

    it("names a home that does not exist yet the way it is named once it exists", () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "argent-home-id-"));
      try {
        fs.mkdirSync(path.join(parent, "real"));
        fs.symlinkSync(path.join(parent, "real"), path.join(parent, "link"));
        const dir = path.join(parent, "link", "fresh");
        const before = argentHomeId(dir);
        fs.mkdirSync(dir);
        expect(argentHomeId(dir)).toBe(before);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });
  });
});

describe("isLocalConnection", () => {
  it.each([
    [{ remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }, true],
    [{ remoteAddress: "::ffff:127.0.0.1", localAddress: "::ffff:127.0.0.1" }, true],
    [{ remoteAddress: "192.168.1.5", localAddress: "192.168.1.5" }, true],
    [{ remoteAddress: "192.168.1.9", localAddress: "192.168.1.5" }, false],
    [{ localAddress: "127.0.0.1" }, false],
  ])("treats %j as local: %s", (socket, local) => {
    expect(isLocalConnection(socket)).toBe(local);
  });
});
