import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  isLiveServiceState,
  type Registry,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import {
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  type JsRuntimeDebuggerApi,
  type RuntimeAppMetadata,
} from "./js-runtime-debugger";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkCaptureControlScript,
} from "../utils/debugger/scripts/network-interceptor";
import { resolveDevice } from "../utils/device-info";

export const NETWORK_INSPECTOR_NAMESPACE = "NetworkInspector";

export interface NetworkInspectorApi {
  port: number;
  cdp: CDPClient;
}

/**
 * Where "since the last start" begins in the app's JS log: the install's token
 * and the last id it gave, or `install: null` when the context had no
 * interceptor of this script at the start, so every record it holds came after.
 */
export type JsCaptureMark = { install: string; lastId: number } | { install: null };

export interface JsCapture {
  bundleId: string;
  intent: "started" | "stopped";
  /** Set by a start; a stop keeps it. */
  mark?: JsCaptureMark;
  /** An interceptor was installed in the app's JS context since the last start. */
  installed: boolean;
  /** A stop paused that interceptor; a start clears it. */
  paused?: true;
}

/**
 * Capture intent of the JS layer, keyed by the NetworkInspector payload
 * `<port>:<device>`. It lives outside the service because a JS reload or a
 * relaunch ends the CDP session, and with it the service, while the intent has
 * to hold for the app's next JS context. One app on one device has at most one
 * entry: storing an intent forgets the app's entries on the device's other
 * Metro ports.
 */
const jsCaptures = new Map<string, JsCapture>();

function splitPayload(payload: string): { port: number; device: string } {
  const at = payload.indexOf(":");
  return { port: Number(payload.slice(0, at)), device: payload.slice(at + 1) };
}

/** Device ids are compared as the stop tools compare them: case-insensitively. */
function sameDevice(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function jsCapturePayload(port: number, device: string): string {
  return `${port}:${device}`;
}

export function jsCapture(payload: string): JsCapture | undefined {
  return jsCaptures.get(payload);
}

/** Forgets the app's entries on the device, on every Metro port. */
export function forgetJsCapture(device: string, bundleId: string): void {
  for (const [payload, capture] of jsCaptures) {
    if (capture.bundleId === bundleId && sameDevice(splitPayload(payload).device, device)) {
      jsCaptures.delete(payload);
    }
  }
}

export function setJsCapture(payload: string, capture: JsCapture): void {
  forgetJsCapture(splitPayload(payload).device, capture.bundleId);
  jsCaptures.set(payload, capture);
}

/** The device's entries, with the Metro port each is on. */
export function jsCapturesOn(device: string): Array<JsCapture & { port: number }> {
  const found: Array<JsCapture & { port: number }> = [];
  for (const [payload, capture] of jsCaptures) {
    const { port, device: of } = splitPayload(payload);
    if (sameDevice(of, device)) found.push({ ...capture, port });
  }
  return found;
}

/** The app's entry on the device, whatever its Metro port. */
export function findJsCapture(
  device: string,
  bundleId: string
): (JsCapture & { port: number }) | undefined {
  return jsCapturesOn(device).find((capture) => capture.bundleId === bundleId);
}

/** The payloads of the devices' entries, or of every entry without them. */
function payloadsOf(devices?: readonly string[]): string[] {
  return [...jsCaptures.keys()].filter((payload) => {
    const { device } = splitPayload(payload);
    return !devices || devices.some((id) => sameDevice(id, device));
  });
}

/** Forgets every entry of the devices, or every entry at all without them. */
export function forgetJsCapturesOf(devices?: readonly string[]): void {
  for (const payload of payloadsOf(devices)) jsCaptures.delete(payload);
}

/** How long a pause waits for each runtime before its debugger is torn down. */
const PAUSE_BEFORE_FORGET_TIMEOUT_MS = 1_000;

/**
 * Pauses the interceptor in each JS context that an entry of the devices (every
 * entry without them) names, while its debugger still runs. The interceptor
 * lives in the app, so forgetting the entry alone leaves it recording. A runtime
 * that does not answer in time is left as it is.
 */
export async function pauseJsCapturesOf(
  registry: Pick<Registry, "getSnapshot" | "resolveService">,
  devices?: readonly string[]
): Promise<void> {
  const services = registry.getSnapshot().services;
  await Promise.all(
    payloadsOf(devices).map(async (payload) => {
      const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`;
      const state = services.get(urn)?.state;
      if (state === undefined || !isLiveServiceState(state)) return;
      try {
        const dbg = await registry.resolveService<JsRuntimeDebuggerApi>(urn);
        await dbg.cdp.evaluate(makeNetworkCaptureControlScript(true), {
          timeout: PAUSE_BEFORE_FORGET_TIMEOUT_MS,
        });
      } catch {
        // The teardown after this closes the connection either way.
      }
    })
  );
}

export type InterceptorInstall = { installed: true } | { installed: false; reason: string };

/**
 * Installs the interceptor in the JS context `cdp` reaches, only for a started
 * capture of the runtime's own app, or of a runtime that names no app. It
 * clears a pause an earlier stop left in the context first. A stopped capture
 * stays paused where it is installed and gets no install in a new context, and
 * the runtime of another app, or of an app never started, gets none either.
 * Vega, which network-capture-start does not cover, installs at every call.
 */
export async function installNetworkInterceptor(
  cdp: CDPClient,
  payload: string,
  runtimeApp: RuntimeAppMetadata | undefined
): Promise<InterceptorInstall> {
  const { device } = splitPayload(payload);
  if (resolveDevice(device).platform === "vega") {
    return parseInstall(await cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT));
  }
  const capture = jsCaptures.get(payload);
  if (capture?.intent !== "started") {
    return { installed: false, reason: `capture is ${capture ? "stopped" : "not started"}` };
  }
  if (runtimeApp?.appId !== undefined && runtimeApp.appId !== capture.bundleId) {
    return { installed: false, reason: `the JS runtime is ${runtimeApp.appId}'s` };
  }
  await cdp.evaluate(makeNetworkCaptureControlScript(false));
  const install = parseInstall(await cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT));
  if (install.installed || install.reason === "already installed") {
    capture.installed = true;
    return { installed: true };
  }
  return install;
}

function parseInstall(raw: unknown): InterceptorInstall {
  try {
    const parsed = JSON.parse(String(raw)) as { installed?: unknown; reason?: unknown };
    if (parsed.installed === true) return { installed: true };
    return {
      installed: false,
      reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
    };
  } catch {
    return { installed: false, reason: `unexpected answer: ${String(raw).slice(0, 200)}` };
  }
}

export const networkInspectorBlueprint: ServiceBlueprint<NetworkInspectorApi, string> = {
  namespace: NETWORK_INSPECTOR_NAMESPACE,

  // payload is "port:deviceId"
  getURN(payload: string) {
    return `${NETWORK_INSPECTOR_NAMESPACE}:${payload}`;
  },

  getDependencies(payload: string) {
    return { debugger: `JsRuntimeDebugger:${payload}` };
  },

  async factory(deps, payload) {
    const debuggerApi = deps.debugger as JsRuntimeDebuggerApi;
    const cdp = debuggerApi.cdp;

    await installNetworkInterceptor(cdp, payload, debuggerApi.runtimeApp).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[NetworkInspector:${debuggerApi.port}] NETWORK_INTERCEPTOR_SCRIPT failed (non-fatal): ${msg}\n`
      );
    });

    const api: NetworkInspectorApi = { port: debuggerApi.port, cdp };

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit(
        "terminated",
        error ??
          new FailureError("CDP disconnected", {
            error_code: FAILURE_CODES.NETWORK_INSPECTOR_CDP_DISCONNECTED,
            failure_stage: "network_inspector_cdp_lifecycle",
            failure_area: "tool_server",
            error_kind: "network",
          })
      );
    });

    return {
      api,
      dispose: async () => {
        // The CDP connection is owned by JsRuntimeDebugger.
      },
      events,
    };
  },
};
