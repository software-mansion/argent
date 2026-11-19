import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { run, type RunCommandOptions } from "../src/run.js";
import * as e2e from "../src/e2e.js";

const REPORT = { e2eTest: "checkout", ok: false, passed: 2, failed: 1, skipped: 7, errored: 0 };
const REASON = 'e2e test "checkout" failed: 2 passed, 1 failed, 0 errored';

// Stands in for the tool-server: `envelope` is the body a POST /tools/e2e-execute returns.
function startServer(
  envelope: () => unknown
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/tools" && req.method === "GET") {
      res.end(
        JSON.stringify({
          tools: [
            {
              name: "e2e-execute",
              description: "",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        })
      );
      return;
    }
    if (req.url?.startsWith("/tools/e2e-execute") && req.method === "POST") {
      req.on("data", () => {});
      req.on("end", () => res.end(JSON.stringify(envelope())));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("argent run — a failure the tool reports in its result", () => {
  let server: { url: string; close: () => Promise<void> };
  let envelope: unknown;
  let logs: string[];
  let errs: string[];
  const opts: RunCommandOptions = { paths: {} as never }; // unused: ARGENT_TOOLS_URL is set

  beforeEach(async () => {
    server = await startServer(() => envelope);
    vi.stubEnv("ARGENT_TOOLS_URL", server.url);
    logs = [];
    errs = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await server.close();
  });

  it("prints the report, then the reason on stderr, and exits 1", async () => {
    envelope = { data: REPORT, failure: REASON };

    await expect(run(["e2e-execute"], opts)).rejects.toThrow("process.exit(1)");

    expect(logs).toEqual([JSON.stringify(REPORT, null, 2)]);
    expect(errs).toEqual([REASON]);
  });

  it("exits through exitAfterFlush on stderr, so the reason is not cut short", async () => {
    envelope = { data: REPORT, failure: REASON };
    const flush = vi.spyOn(e2e, "exitAfterFlush");

    await expect(run(["e2e-execute"], opts)).rejects.toThrow("process.exit(1)");

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(1, [process.stderr]);
  });

  it("writes the reason only after stdout drains, so a merged log ends with it", async () => {
    envelope = { data: REPORT, failure: REASON };
    const order: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => void order.push("report"));
    vi.spyOn(console, "error").mockImplementation(() => void order.push("reason"));
    vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: unknown, cb?: () => void) => {
      setTimeout(() => {
        order.push("stdout drained");
        cb?.();
      }, 20);
      return false;
    }) as never);

    await expect(run(["e2e-execute"], opts)).rejects.toThrow("process.exit(1)");

    expect(order).toEqual(["report", "stdout drained", "reason"]);
  });

  it("keeps the --json report on stdout and still exits 1", async () => {
    envelope = { data: REPORT, failure: REASON };

    await expect(run(["e2e-execute", "--json"], opts)).rejects.toThrow("process.exit(1)");

    expect(JSON.parse(logs.join("\n"))).toEqual(REPORT);
    expect(errs).toEqual([REASON]);
  });

  it("returns without exiting when the result reports no failure", async () => {
    envelope = { data: { ...REPORT, ok: true, failed: 0 } };

    await expect(run(["e2e-execute"], opts)).resolves.toBeUndefined();

    expect(process.exit).not.toHaveBeenCalled();
    expect(errs).toEqual([]);
  });
});
