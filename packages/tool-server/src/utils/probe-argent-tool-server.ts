import * as http from "node:http";
import { ARGENT_HOME_HEADER, argentHomeId, peerArgentHomeId } from "./argent-home-id";

/**
 * Whether a healthy argent tool-server using this instance's Argent home already
 * owns `host:port`, so an instance that lost the bind with EADDRINUSE can exit 0
 * instead of crash-looping.
 *
 * `GET /tools` answering 200, or 401 when an auth token is configured, both
 * prove a live argent peer; no token is sent. A peer under another Argent home
 * (`ARGENT_HOME_DIR`) resolves `false`: its CLI and MCP clients are not ours. A
 * peer that never answers within the timeout resolves `false`, so a wedged port
 * still surfaces as a crash.
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
        const isArgentPeer =
          (res.statusCode === 200 || res.statusCode === 401) &&
          peerArgentHomeId(res.headers[ARGENT_HOME_HEADER]) === argentHomeId();
        res.resume(); // drain so the socket can close
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
