import * as http from "node:http";
import { pickFreePort } from "../../src/utils/free-port";

/**
 * Stub CDP endpoint answering `/json/version` (all waitForCdpReady probes) and
 * any extra JSON `routes`. It reserves its port but listens only once `listen()`
 * runs: bootElectronApp refuses a fixed port that already answers, so call it
 * from the spawn mock, where a real child would open the port.
 */
export async function createCdpStub(
  routes: Record<string, unknown> = {},
  onVersionServed?: () => void
): Promise<{ port: number; listen: () => void; close: () => void }> {
  const port = await pickFreePort();
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
      onVersionServed?.();
      return;
    }
    if (req.url && req.url in routes) {
      res.end(JSON.stringify(routes[req.url]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return {
    port,
    listen: () => srv.listen(port, "127.0.0.1"),
    close: () => srv.close(),
  };
}
