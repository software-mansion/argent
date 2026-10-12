import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { discoverPrimaryPage } from "../src/chromium-server/cdp-session";

/**
 * Both CHROMIUM_CDP_NO_PAGE_TARGET throw sites are only reachable after
 * `/json/list` answered, so neither may question the debug flag: a missing
 * `--remote-debugging-port` fails earlier as CHROMIUM_CDP_UNREACHABLE. The
 * message is what `debugger-status` hands the agent as `detail`, and its
 * Chromium `cdp_unreachable` guidance defers to that detail, so a wrong
 * diagnosis here is what the agent acts on.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Serves `targets` from `/json/list`; returns the listening port. */
async function serveTargets(targets: unknown[]): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(targets));
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return (server.address() as { port: number }).port;
}

async function messageOf(port: number): Promise<string> {
  try {
    await discoverPrimaryPage(port);
  } catch (err) {
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET);
    return (err as Error).message;
  }
  throw new Error("expected discoverPrimaryPage to throw");
}

describe("no-page-target message", () => {
  it("reports a windowless app when the list holds no page target at all", async () => {
    const message = await messageOf(
      await serveTargets([{ id: "1", type: "service_worker", title: "sw", url: "chrome://x" }])
    );
    expect(message).not.toMatch(/--remote-debugging-port/);
    expect(message).toMatch(/window/i);
  });

  it("reports a hidden or closed window when only devtools:// pages remain", async () => {
    const message = await messageOf(
      await serveTargets([
        {
          id: "1",
          type: "page",
          title: "DevTools",
          url: "devtools://devtools/bundled/inspector.html",
          webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1",
        },
      ])
    );
    expect(message).not.toMatch(/--remote-debugging-port/);
    expect(message).toMatch(/window/i);
  });
});
