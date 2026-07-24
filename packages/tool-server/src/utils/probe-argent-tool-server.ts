import * as http from "node:http";

/**
 * Probe whether a healthy argent tool-server is already listening on
 * `host:port`. Used to tell a redundant/overlapping instance (which lost the
 * bind with EADDRINUSE) that the port is owned by a live peer, so it can defer
 * cleanly instead of crash-looping.
 *
 * An argent tool-server answers `GET /tools` with 200 (the tools JSON) or, when
 * an auth token is configured, 401 — either proves a live argent peer. No token
 * is sent: reachability + argent-shaped response is all we need. A wedged peer
 * that never answers within the timeout resolves `false`, so we still surface a
 * genuinely stuck port as a crash rather than deferring to a dead server.
 */
export function probeArgentToolServer(
  host: string,
  port: number,
  timeoutMs = 500
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: "/tools", method: "GET", timeout: timeoutMs },
      (res) => {
        const isArgentPeer = res.statusCode === 200 || res.statusCode === 401;
        res.resume(); // drain the response so the socket can close
        resolve(isArgentPeer);
      }
    );
    req.on("error", () => resolve(false)); // connection refused / reset / non-HTTP
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}
