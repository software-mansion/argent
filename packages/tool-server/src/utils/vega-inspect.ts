/**
 * Vega screen inspection — host-side over `adb`, no bundled binary.
 *
 * The page source comes from the on-device automation toolkit, which serves
 * JSON-RPC on `127.0.0.1:8383` (the toolkit attaches at app launch; argent
 * enables it via `ensureAutomationToolkitEnabled`). We reach it host-side by
 * forwarding a deterministic localhost port to the device's toolkit port with
 * `adb forward`, POST the `getPageSource` JSON-RPC, and return the XML string.
 *
 * This replaces `vega-fast-cli inspect`, whose on-device server was itself just
 * a thin proxy to this same `:8383` toolkit endpoint — so talking to it directly
 * removes the host binary without losing any capability.
 */
import { request } from "node:http";
import { runAdb } from "./adb";
import { emulatorSerial } from "./vega-automation";

// The toolkit's fixed on-device JSON-RPC port.
const TOOLKIT_DEVICE_PORT = 8383;
// Host-side forward port = console port + offset, so repeated calls reuse the
// same idempotent `adb forward` instead of leaking ports (mirrors vega-fast-cli).
const HOST_PORT_OFFSET = 10_000;

/**
 * Fetch the current Vega screen's page-source XML from the on-device automation
 * toolkit. Returns the raw XML string; the caller (describe) handles parsing and
 * the empty/unavailable case. Throws if the VVD can't be discovered, the forward
 * fails, or the toolkit returns an error / is unreachable.
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
    // getPageSource returns the XML as a JSON string; tolerate a structured
    // value by stringifying (matches vega-fast-cli's fallback).
    return typeof result === "string" ? result : JSON.stringify(result ?? "");
  } finally {
    // Best-effort: drop the forward so a long-lived server doesn't accrete them.
    await runAdb(["-s", serial, "forward", "--remove", `tcp:${hostPort}`], {
      timeoutMs: 5_000,
    }).catch(() => {});
  }
}

/** Minimal HTTP POST returning the response body, for the forwarded toolkit port. */
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
          // A forwarded toolkit can answer non-2xx (e.g. the JSON-RPC endpoint is
          // down and a gateway responds 500). Reject instead of handing the error
          // body downstream as if it were page source — otherwise a success-shaped
          // 500 body gets parsed as a real tree, and a structured/empty error body
          // gets misreported as an empty screen. The caller's empty-tree + relaunch
          // hint then covers it, as for every other toolkit-level failure here.
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
