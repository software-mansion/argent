import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the adb + console-port helpers the transport leans on.
const runAdb = vi.fn();
vi.mock("../src/utils/adb", () => ({ runAdb: (...a: unknown[]) => runAdb(...a) }));
vi.mock("../src/utils/vega-qmp", () => ({ discoverVegaConsolePort: vi.fn(async () => 5554) }));

import {
  vegaJsonRpc,
  fetchVegaPageSource,
  ensureAutomationToolkitEnabled,
  VegaToolkitUnavailableError,
} from "../src/utils/vega-automation";

const realFetch = globalThis.fetch;

beforeEach(() => {
  runAdb.mockReset();
  runAdb.mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("ensureAutomationToolkitEnabled", () => {
  it("touches the enable flag on the derived emulator serial", async () => {
    await ensureAutomationToolkitEnabled("amazon-abc");
    expect(runAdb).toHaveBeenCalledWith(
      ["-s", "emulator-5554", "shell", "touch", "/tmp/automation-toolkit.enable"],
      expect.any(Object)
    );
  });
});

describe("vegaJsonRpc", () => {
  it("forwards a deterministic host port to device 8383 and POSTs JSON-RPC", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "0", result: "OK" }))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await vegaJsonRpc("amazon-abc", "getPageSource", {});
    expect(result).toBe("OK");

    // host port = consolePort (5554) + 10000
    expect(runAdb).toHaveBeenCalledWith(
      ["-s", "emulator-5554", "forward", "tcp:15554", "tcp:8383"],
      expect.any(Object)
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:15554/jsonrpc");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      jsonrpc: "2.0",
      id: "0",
      method: "getPageSource",
      params: {},
    });
  });

  it("raises a JSON-RPC error result as a hard error", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "0", error: { code: -32602, message: "INVALID_PARAMS" } })
        )
    ) as unknown as typeof fetch;
    await expect(vegaJsonRpc("x", "findObjects", {})).rejects.toThrow(/INVALID_PARAMS/);
  });

  it("maps a network-level failure to VegaToolkitUnavailableError", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed"); // ECONNRESET / socket hang up
    }) as unknown as typeof fetch;
    await expect(vegaJsonRpc("x", "getPageSource", {})).rejects.toBeInstanceOf(
      VegaToolkitUnavailableError
    );
  });
});

describe("fetchVegaPageSource", () => {
  it("returns ok with the XML for a served page source", async () => {
    const xml = '<?xml version="1.0"?><root>' + "x".repeat(100) + "</root>";
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "0", result: xml }))
    ) as unknown as typeof fetch;
    const out = await fetchVegaPageSource("x");
    expect(out).toEqual({ ok: true, xml });
  });

  it("reports toolkit-unavailable when the server closes the connection", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchVegaPageSource("x")).toEqual({ ok: false, reason: "toolkit-unavailable" });
  });

  it("reports toolkit-unavailable for an empty/too-short root", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "0", result: "<root/>" }))
    ) as unknown as typeof fetch;
    expect(await fetchVegaPageSource("x")).toEqual({ ok: false, reason: "toolkit-unavailable" });
  });
});
