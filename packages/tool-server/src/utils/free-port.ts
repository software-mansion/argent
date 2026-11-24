import * as net from "node:net";

/**
 * Ask the kernel for a currently-free loopback TCP port by binding port 0 and
 * reading the assignment back.
 *
 * Inherently best-effort: the port is only free until something else binds it,
 * so callers bind or connect promptly and let their own error path report a lost
 * race.
 *
 * The throwaway server is unref'd so a pick can never hold the event loop open.
 */
export async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();

    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not allocate a free TCP port")));
      }
    });
  });
}
