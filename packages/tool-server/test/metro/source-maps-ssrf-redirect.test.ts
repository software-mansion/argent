import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { SourceMapsRegistry, isAllowedSourceMapURL } from "../../src/utils/debugger/source-maps";

// Repro for PR #194 review Issue 2: isAllowedSourceMapURL only validates the
// FIRST-HOP URL. doRegister() then does `fetch(sourceMapURL)` which follows
// redirects by default and never re-validates the redirect target, so a
// loopback URL (passes the allowlist) that 302-redirects to an internal host
// is still fetched -> SSRF not actually closed.

const VALID_MAP = JSON.stringify({
  version: 3,
  sources: ["x.js"],
  sourcesContent: ["x"],
  mappings: "",
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port))
  );
}

describe("source-map SSRF — redirect vector (PR #194 Issue 2)", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("a direct non-loopback sourceMapURL is correctly rejected (baseline)", () => {
    expect(isAllowedSourceMapURL("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("follows a loopback redirect to an 'internal' host and fetches it (the bug)", async () => {
    // "internal" target — stands in for 169.254.169.254 / an intranet service.
    // Loopback only so the test can observe the hit; the code path that
    // reaches it is identical for any host the Location header names.
    let internalHit = 0;
    const internal = http.createServer((req, res) => {
      internalHit++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(VALID_MAP);
    });
    servers.push(internal);
    const internalPort = await listen(internal);

    // Redirector — a loopback URL the attacker points //# sourceMappingURL at.
    // isAllowedSourceMapURL passes it (loopback). It 302s to the internal host.
    const redirector = http.createServer((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/latest/meta-data/iam/` });
      res.end();
    });
    servers.push(redirector);
    const redirPort = await listen(redirector);

    const attackerMapUrl = `http://127.0.0.1:${redirPort}/evil.map`;
    expect(isAllowedSourceMapURL(attackerMapUrl)).toBe(true); // first hop passes the gate

    const reg = new SourceMapsRegistry("/tmp");
    reg.registerFromScriptParsed(
      "http://127.0.0.1:" + redirPort + "/bundle.js",
      "1",
      attackerMapUrl
    );
    await reg.waitForPending();

    // BUG: the redirect target was fetched. After the fix this must be 0.
    expect(internalHit).toBe(0);
  });
});
