import { vi } from "vitest";
import { isFlagEnabled } from "@argent/configuration-core";
import { FAILURE_CODES, Registry } from "@argent/registry";
import {
  macosAppRef,
  type MacosAppApi,
  type MacosAppConnection,
} from "../../src/blueprints/macos-app";
import { resolveDevice } from "../../src/utils/device-info";
import { macosFailure } from "../../src/utils/macos-apps";

export const MAC_ID = "macos-app-com.example.Probe";
export const MAC_BUNDLE_ID = "com.example.Probe";
export const MAC_PID = 4321;
export const MAC_URN = macosAppRef(resolveDevice(MAC_ID)).urn;

export interface LibraryCall {
  method: string;
  params: Record<string, unknown>;
  opts?: { timeoutMs?: number; runLate?: boolean; connection?: MacosAppConnection };
}

type Handlers = Record<string, (params: Record<string, unknown>) => unknown>;

/**
 * A stand-in for the in-app library of a Mac app: `handlers` answer by method,
 * anything else answers `{}`. Each reply resolves a microtask later, and
 * `overlapped()` says whether a request went out before the previous one
 * answered. `connect()` hands out one connection, which `closeConnection()`
 * closes: a call bound to it then fails without reaching the handlers.
 */
export function fakeMacosApp(handlers: Handlers = {}) {
  const calls: LibraryCall[] = [];
  let pending = 0;
  let overlapped = false;
  let open = true;
  const connection: MacosAppConnection = {
    pid: MAC_PID,
    get isOpen() {
      return open;
    },
  };
  const call = async (
    method: string,
    params: Record<string, unknown> = {},
    opts?: LibraryCall["opts"]
  ) => {
    if (opts?.connection && !opts.connection.isOpen) {
      throw macosFailure(
        `The connection to ${MAC_BUNDLE_ID} that ${method} was bound to has closed.`,
        FAILURE_CODES.MACOS_APP_CONNECTION_LOST,
        "macos_app_connection",
        "unknown"
      );
    }
    if (pending > 0) overlapped = true;
    pending++;
    calls.push({ method, params, ...(opts ? { opts } : {}) });
    try {
      await Promise.resolve();
      return handlers[method]?.(params) ?? {};
    } finally {
      pending--;
    }
  };
  const app = {
    bundleId: MAC_BUNDLE_ID,
    call: vi.fn(call),
    connect: vi.fn(async () => connection),
    handshake: vi.fn(() =>
      open ? { bundleId: MAC_BUNDLE_ID, pid: MAC_PID, platform: "macos", protocol: 1 } : null
    ),
  } as unknown as MacosAppApi;
  return {
    app,
    calls,
    connection,
    closeConnection: () => {
      open = false;
    },
    overlapped: () => overlapped,
  };
}

/**
 * A registry with `tools`, gated on the real flags, whose services are `app`
 * and `services` (by URN). Every URN a tool resolves is recorded, so a test can
 * prove a Mac id reaches no other backend.
 */
export function macosToolRegistry(
  app: MacosAppApi,
  tools: (registry: Registry) => unknown[],
  services: Record<string, unknown> = {}
) {
  const registry = new Registry({ isFlagEnabled: (flag) => isFlagEnabled(flag) });
  const urns: string[] = [];
  vi.spyOn(registry, "resolveService").mockImplementation(async (urn: string) => {
    urns.push(urn);
    if (urn === MAC_URN) return app as never;
    if (urn in services) return services[urn] as never;
    throw new Error(`a Mac id reached ${urn}`);
  });
  for (const tool of tools(registry)) registry.registerTool(tool as never);
  return { registry, urns };
}

export const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error
  );
