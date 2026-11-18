import { vi } from "vitest";
import { isFlagEnabled } from "@argent/configuration-core";
import { Registry } from "@argent/registry";
import { macosAppRef, type MacosAppApi } from "../../src/blueprints/macos-app";
import { resolveDevice } from "../../src/utils/device-info";

export const MAC_ID = "macos-app-com.example.Probe";
export const MAC_BUNDLE_ID = "com.example.Probe";
export const MAC_URN = macosAppRef(resolveDevice(MAC_ID)).urn;

export interface LibraryCall {
  method: string;
  params: Record<string, unknown>;
  opts?: { timeoutMs?: number; runLate?: boolean };
}

type Handlers = Record<string, (params: Record<string, unknown>) => unknown>;

/**
 * A stand-in for the in-app library of a Mac app: `handlers` answer by method,
 * anything else answers `{}`. Each reply resolves a microtask later, and
 * `overlapped()` says whether a request went out before the previous one
 * answered.
 */
export function fakeMacosApp(handlers: Handlers = {}) {
  const calls: LibraryCall[] = [];
  let pending = 0;
  let overlapped = false;
  const call = async (
    method: string,
    params: Record<string, unknown> = {},
    opts?: { timeoutMs?: number; runLate?: boolean }
  ) => {
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
  const app = { bundleId: MAC_BUNDLE_ID, call: vi.fn(call) } as unknown as MacosAppApi;
  return { app, calls, overlapped: () => overlapped };
}

/**
 * A registry with `tools`, gated on the real flags, whose only service is
 * `app`. Every URN a tool resolves is recorded, so a test can prove a Mac id
 * reaches no other backend.
 */
export function macosToolRegistry(app: MacosAppApi, tools: (registry: Registry) => unknown[]) {
  const registry = new Registry({ isFlagEnabled: (flag) => isFlagEnabled(flag) });
  const urns: string[] = [];
  vi.spyOn(registry, "resolveService").mockImplementation(async (urn: string) => {
    urns.push(urn);
    if (urn === MAC_URN) return app as never;
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
