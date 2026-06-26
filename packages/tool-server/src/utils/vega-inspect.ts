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
import { FAILURE_CODES, FailureError } from "@argent/registry";
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
      // The toolkit answered but its body isn't valid JSON — a parse failure,
      // not a fetch/transport one. Distinct from VEGA_PAGE_SOURCE_PARSE_FAILED's
      // XML-structure parse, but the same "got bytes, couldn't decode" class.
      throw new FailureError(
        `bad toolkit JSON: ${e instanceof Error ? e.message : String(e)}`,
        {
          error_code: FAILURE_CODES.VEGA_PAGE_SOURCE_PARSE_FAILED,
          failure_stage: "vega_toolkit_response_json",
          failure_area: "tool_server",
          error_kind: "unknown",
        },
        { cause: e instanceof Error ? e : new Error(String(e)) }
      );
    }
    if (parsed.error !== undefined) {
      // Transport fully succeeded and the toolkit explicitly returned an error
      // object — a logical RPC failure, not a fetch/network one. Distinct code
      // so VEGA_PAGE_SOURCE_FETCH_FAILED stays exclusively transport-level
      // (consistently error_kind "network").
      throw new FailureError(`toolkit error: ${JSON.stringify(parsed.error)}`, {
        error_code: FAILURE_CODES.VEGA_PAGE_SOURCE_RPC_ERROR,
        failure_stage: "vega_toolkit_rpc_error",
        failure_area: "tool_server",
        error_kind: "unknown",
      });
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
            // Reachable and answered, just a non-2xx status — a malformed
            // response, not a down endpoint. Distinct code from the connect-
            // failure path below so it mirrors the chromium CDP split
            // (UNREACHABLE vs INVALID_RESPONSE): VEGA_PAGE_SOURCE_FETCH_FAILED
            // stays exclusively for transport/connect failures.
            reject(
              new FailureError(`toolkit HTTP ${status}: ${data.slice(0, 200)}`, {
                error_code: FAILURE_CODES.VEGA_PAGE_SOURCE_HTTP_ERROR,
                failure_stage: "vega_toolkit_http_status",
                failure_area: "tool_server",
                error_kind: "network",
                network_failure: "invalid_response",
              })
            );
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", (err) => {
      // The common case: nothing is listening on the forwarded toolkit port
      // (the automation toolkit isn't attached — relaunch the app), so the
      // connect is refused. Map the well-known socket codes; everything else
      // is an unclassified transport error.
      const code = (err as NodeJS.ErrnoException).code;
      const network_failure =
        code === "ECONNREFUSED"
          ? "connection_refused"
          : code === "ECONNRESET"
            ? "connection_reset"
            : "other";
      reject(
        new FailureError(
          `toolkit request failed: ${err instanceof Error ? err.message : String(err)}`,
          {
            error_code: FAILURE_CODES.VEGA_PAGE_SOURCE_FETCH_FAILED,
            failure_stage: "vega_toolkit_request_error",
            failure_area: "tool_server",
            error_kind: "network",
            network_failure,
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        )
      );
    });
    req.on("timeout", () => {
      // Reject with the precise timeout classification first; the subsequent
      // destroy() carries no error so it won't emit 'error', and Promise reject
      // is idempotent — the network 'error' path can't override this.
      reject(
        new FailureError(`toolkit request timed out after ${timeoutMs}ms`, {
          error_code: FAILURE_CODES.VEGA_PAGE_SOURCE_TIMEOUT,
          failure_stage: "vega_toolkit_request_timeout",
          failure_area: "tool_server",
          error_kind: "timeout",
        })
      );
      req.destroy();
    });
    req.write(body);
    req.end();
  });
}
