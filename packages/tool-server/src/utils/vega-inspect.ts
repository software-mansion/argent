/**
 * Vega screen inspection over `adb`: forward a host port to the on-device
 * automation toolkit's JSON-RPC port and POST `getPageSource`.
 *
 * The toolkit attaches at app launch; argent enables it via
 * `ensureAutomationToolkitEnabled`.
 */
import { request } from "node:http";
import { runAdb } from "./adb";
import { emulatorSerial } from "./vega-automation";

const TOOLKIT_DEVICE_PORT = 8383;
// Derived from the console port so repeated calls reuse one idempotent
// `adb forward` instead of leaking ports.
const HOST_PORT_OFFSET = 10_000;

/**
 * Raw page-source XML from the on-device automation toolkit; describe parses it
 * and handles the empty/unavailable case. Throws if the VVD can't be discovered,
 * the forward fails, or the toolkit errors / is unreachable.
 */
export async function fetchVegaPageSource(timeoutMs = 15_000): Promise<string> {
  const { serial, consolePort } = await emulatorSerial();
  const hostPort = consolePort + HOST_PORT_OFFSET;

  await runAdb(["-s", serial, "forward", `tcp:${hostPort}`, `tcp:${TOOLKIT_DEVICE_PORT}`], {
    timeoutMs: 10_000,
  });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getPageSource", params: {} });
    const respText = await postJson("127.0.0.1", hostPort, "/jsonrpc", body, timeoutMs);
    let parsed: { result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(respText) as { result?: unknown; error?: unknown };
    } catch (e) {
      throw new Error(`bad toolkit JSON: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
    if (parsed.error !== undefined) {
      throw new Error(`toolkit error: ${JSON.stringify(parsed.error)}`);
    }
    const result = parsed.result;
    // getPageSource returns the XML as a JSON string; tolerate a structured value.
    return typeof result === "string" ? result : JSON.stringify(result ?? "");
  } finally {
    // Drop the forward so a long-lived server doesn't accrete them.
    await runAdb(["-s", serial, "forward", "--remove", `tcp:${hostPort}`], {
      timeoutMs: 5_000,
    }).catch(() => {});
  }
}

function postJson(
  host: string,
  port: number,
  path: string,
  body: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Reject non-2xx: an error body handed downstream would either parse as
          // a real tree or be misreported as an empty screen.
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`toolkit HTTP ${status}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () =>
      req.destroy(new Error(`toolkit request timed out after ${timeoutMs}ms`))
    );
    req.write(body);
    req.end();
  });
}
