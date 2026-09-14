import { describe, it, expect, afterEach, vi } from "vitest";
import { Registry, ServiceState, FAILURE_CODES, FailureError } from "@argent/registry";
import {
  jsRuntimeDebuggerBlueprint,
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { startMockMetroCdp, type MockMetroCdp } from "./metro-cdp-harness";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-debugger-recovery-home-");

/**
 * Reachability proof for the Metro blueprint's dispose-and-retry recovery
 * (Registry._recoverFailedServices consults recoverable() only for a node
 * still RUNNING).
 *
 * On this blueprint a DETECTED socket death tears the node down via the
 * terminated cascade before the failing call's catch runs, so the only
 * reachable window is the send() guard rejecting (NOT_CONNECTED) while the
 * WebSocket is CLOSING but the close event has not dispatched — the request
 * provably never left the host. The test forges that state by stubbing the
 * cached client's send to reject with the classified NOT_CONNECTED error while
 * the node provably stays RUNNING (no cascade fires), then asserts exactly one
 * dispose-and-retry: the factory runs a second time and the call succeeds.
 */

const NOT_CONNECTED = () =>
  new FailureError("CDP not connected", {
    error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
    failure_stage: "debugger_cdp_send",
    failure_area: "tool_server",
    error_kind: "network",
  });

const CONNECTION_CLOSED = () =>
  new FailureError("CDP connection closed", {
    error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
    failure_stage: "debugger_cdp_lifecycle",
    failure_area: "tool_server",
    error_kind: "network",
  });

let metro: MockMetroCdp | null = null;
let registry: Registry | null = null;

afterEach(async () => {
  await registry?.dispose();
  await metro?.close();
  registry = null;
  metro = null;
  vi.restoreAllMocks();
});

async function setup() {
  metro = await startMockMetroCdp();
  const factorySpy = vi.fn(jsRuntimeDebuggerBlueprint.factory);
  registry = new Registry();
  registry.registerBlueprint({ ...jsRuntimeDebuggerBlueprint, factory: factorySpy });
  registry.registerTool(debuggerEvaluateTool);
  const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${metro.port}:mock-device`;
  const api = await registry.resolveService<JsRuntimeDebuggerApi>(urn);
  expect(registry.getServiceState(urn)).toBe(ServiceState.RUNNING);
  expect(factorySpy).toHaveBeenCalledTimes(1);
  return { registry, metro, urn, api, factorySpy };
}

describe("registry recovery reachability (Metro debugger)", () => {
  it("NOT_CONNECTED while RUNNING → exactly one dispose-and-retry, and the retry succeeds", async () => {
    const { registry, metro, urn, api, factorySpy } = await setup();

    // Forge the send-guard rejection on the CACHED client; the node stays
    // RUNNING because no socket event (and hence no terminated cascade) fires.
    vi.spyOn(api.cdp, "send").mockRejectedValue(NOT_CONNECTED());

    const result = (await registry.invokeTool("debugger-evaluate", {
      port: metro.port,
      device_id: "mock-device",
      expression: "1 + 1",
    })) as { result: unknown };

    // The retry ran against a FRESH instance (factory re-invoked exactly once
    // more) whose unstubbed client got the mock server's real answer.
    expect(result.result).toBe("mock");
    expect(factorySpy).toHaveBeenCalledTimes(2);
    expect(registry.getServiceState(urn)).toBe(ServiceState.RUNNING);
  });

  it("CONNECTION_CLOSED while RUNNING is NOT recovered — the call fails once, no retry", async () => {
    // Double-execution guard: a request rejected by cleanup() was already
    // delivered and may have taken effect, so the Metro blueprint must not
    // dispose-and-retry on it even in the (test-forged) RUNNING state.
    const { registry, metro, urn, api, factorySpy } = await setup();

    vi.spyOn(api.cdp, "send").mockRejectedValue(CONNECTION_CLOSED());

    await expect(
      registry.invokeTool("debugger-evaluate", {
        port: metro.port,
        device_id: "mock-device",
        expression: "1 + 1",
      })
    ).rejects.toThrow(/CDP connection closed/);

    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(registry.getServiceState(urn)).toBe(ServiceState.RUNNING);
  });
});
