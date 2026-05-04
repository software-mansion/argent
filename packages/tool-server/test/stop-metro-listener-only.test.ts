/**
 * `lsof -ti tcp:<port>` returns BOTH the listener AND any connected
 * client processes. stop-metro must only target the LISTEN process —
 * never the clients (curl, browser dev tools, debuggers, etc.).
 *
 * We exercise this end-to-end with a real listener + multiple real
 * clients connected to the listener port, and confirm stop-metro
 * SIGTERMs the listener (this test process) but spares the clients.
 *
 * Note: this only runs on darwin/linux where `lsof -ti` is available.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, Socket } from "node:net";
import { execFileSync } from "node:child_process";

import { stopMetroTool } from "../src/tools/simulator/stop-metro";

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function lsofAvailable(): boolean {
  // Ensure /usr/sbin (where lsof lives on macOS) is on PATH for the
  // child execSync call inside stop-metro; the prescribed test PATH
  // omits it.
  const parts = (process.env.PATH ?? "").split(":");
  if (!parts.includes("/usr/sbin")) {
    process.env.PATH = parts.concat("/usr/sbin").join(":");
  }
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("stop-metro: only kills the LISTEN process, not connected clients", () => {
  let server: Server | null = null;
  let clientProcs: ChildProcess[] = [];
  let killSpy: ReturnType<typeof vi.spyOn> | null = null;
  const killed: Array<[number, NodeJS.Signals | number | undefined]> = [];

  beforeEach(() => {
    killed.length = 0;
    killSpy = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      sig?: NodeJS.Signals | number
    ) => {
      killed.push([pid, sig]);
      return true;
    }) as typeof process.kill);
  });

  afterEach(async () => {
    killSpy?.mockRestore();
    for (const c of clientProcs) {
      if (c.pid && !c.killed) {
        try {
          c.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    clientProcs = [];
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it.skipIf(!lsofAvailable())(
    "spares connected client pids and only targets the listener",
    async () => {
      // 1. Start a stub "Metro" listener on a free port.
      const port = await pickFreePort();
      server = createServer((socket: Socket) => {
        // Keep connection open; never respond.
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) => server!.listen(port, resolve));

      // 2. Spawn two real client processes that hold a TCP connection
      //    open to that port. We use `node -e` to start a long-lived
      //    connection so lsof has something to report for each.
      const spawnClient = (): ChildProcess => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `const net = require('node:net');
             const c = net.createConnection({ port: ${port} });
             c.on('error', () => {});
             // Keep the process alive until parent kills us.
             setInterval(() => {}, 60000);`,
          ],
          { stdio: "ignore" }
        );
        return child;
      };

      const clientA = spawnClient();
      const clientB = spawnClient();
      clientProcs.push(clientA, clientB);

      // Wait for the kernel to register both clients.
      await new Promise((r) => setTimeout(r, 250));

      // 3. Run the tool. It should ask lsof for LISTEN pids on `port`
      //    and SIGTERM only those. Our process.kill spy captures the
      //    targets.
      const result = await stopMetroTool.execute!({}, { port });

      // 4. The tool fired SIGTERM at the listener (this process) but
      //    NOT at either client. After the fix, `lsof -ti -sTCP:LISTEN`
      //    excludes connected clients.
      const killedPids = new Set(killed.map(([pid]) => pid));

      expect(result.stopped).toBe(true);
      expect(killedPids.has(process.pid)).toBe(true);
      expect(killedPids.has(clientA.pid!)).toBe(false);
      expect(killedPids.has(clientB.pid!)).toBe(false);
      // And the reported pids should match what we killed.
      expect(new Set(result.pids)).toEqual(killedPids);
    },
    20_000
  );
});
