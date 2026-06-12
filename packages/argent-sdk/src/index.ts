import * as fs from "node:fs";
import * as path from "node:path";
import {
  createToolsClient,
  materializeArtifacts,
  getDeviceIdFromArgs,
  killToolServer,
  type ToolsClient,
  type ToolMeta,
  type ToolsServerPaths,
  type MaterializedImage,
} from "@argent/tools-client";
// Type-only by design (enforced by verbatimModuleSyntax): the SDK derives its
// typed surface from the server's tool definitions but must never bundle the
// server. The publish pipeline additionally asserts no tool-server source
// reaches the SDK bundle (see packages/argent/scripts/bundle-tools.cjs).
import type { AllTools } from "@argent/tool-server";
import type { ToolDefinition } from "@argent/registry";

export type { ToolMeta, ToolsServerPaths, MaterializedImage };

// ── Typed tool surface, derived from the server's manifest ──────────────────

// Params use the schema's INPUT type (third generic): fields with `.default()`
// stay optional for callers, while the server applies defaults after parsing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ParamsOf<T> = T extends ToolDefinition<any, any, infer I> ? I : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResultOf<T> = T extends ToolDefinition<any, infer R, any> ? R : never;

export type ToolName = keyof AllTools;
export type ToolParams<K extends ToolName> = ParamsOf<AllTools[K]>;
export type ToolResult<K extends ToolName> = ResultOf<AllTools[K]>;

type KebabToCamel<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
  : S;

/**
 * Parameter tuple for one params type: no argument for `void`, optional
 * argument when every field is optional, required otherwise.
 */
type ArgsTuple<P> = [P] extends [void]
  ? []
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {} extends P
    ? [params?: P]
    : [params: P];

type ToolCallArgs<K extends ToolName> = ArgsTuple<ToolParams<K>>;

type ToolMethod<K extends ToolName> = (...args: ToolCallArgs<K>) => Promise<ToolResult<K>>;

// ── Device-bound surface ─────────────────────────────────────────────────────

/**
 * Param keys a device handle injects. Interaction tools take `udid`, the
 * debugger/profiler family takes `device_id` — same value (iOS UDID or adb
 * serial), different spelling. Injection is schema-aware at runtime: only the
 * keys a tool's served input schema declares are added, so `.strict()`
 * schemas (e.g. screenshot-diff) never see an unexpected key.
 */
const DEVICE_BIND_KEYS = ["udid", "device_id"] as const;
type DeviceBindKey = (typeof DEVICE_BIND_KEYS)[number];

type DeviceParams<K extends ToolName> =
  ToolParams<K> extends void ? void : Omit<ToolParams<K>, DeviceBindKey>;

type DeviceCallArgs<K extends ToolName> = ArgsTuple<DeviceParams<K>>;

type DeviceToolMethod<K extends ToolName> = (...args: DeviceCallArgs<K>) => Promise<ToolResult<K>>;

/** Per-tool methods with the device id keys already bound. */
export type ArgentDeviceToolMethods = {
  [K in ToolName as KebabToCamel<K>]: DeviceToolMethod<K>;
};

/** One camelCased method per served tool, e.g. `gestureTap` → `gesture-tap`. */
export type ArgentToolMethods = {
  [K in ToolName as KebabToCamel<K>]: ToolMethod<K>;
};

/** Ergonomic shorthands for the most common interactions. */
const TOOL_ALIASES = {
  tap: "gesture-tap",
  swipe: "gesture-swipe",
  pinch: "gesture-pinch",
} as const satisfies Record<string, ToolName>;

export type ArgentAliasMethods = {
  [A in keyof typeof TOOL_ALIASES]: ToolMethod<(typeof TOOL_ALIASES)[A]>;
};

export type ArgentDeviceAliasMethods = {
  [A in keyof typeof TOOL_ALIASES]: DeviceToolMethod<(typeof TOOL_ALIASES)[A]>;
};

/** Full invocation envelope, for callers that need more than the result data. */
export interface ToolInvocation<TResult = unknown> {
  data: TResult;
  /** Out-of-band note from the tool-server (update hints etc.). */
  note?: string;
  /** Image artifacts already materialized to local files. */
  images: MaterializedImage[];
}

/**
 * A client bound to one device: tool methods drop the `udid` / `device_id`
 * params and the handle supplies them. Obtain via `argent.device(udid)`, or
 * `argent.device()` to auto-bind the single booted simulator/emulator.
 */
export interface ArgentDevice extends ArgentDeviceToolMethods, ArgentDeviceAliasMethods {
  /** Invoke a tool by id with the device id keys bound. */
  call<K extends ToolName>(name: K, ...args: DeviceCallArgs<K>): Promise<ToolResult<K>>;
  /** Like `call`, but returns the full envelope (data + note + materialized images). */
  invoke<K extends ToolName>(
    name: K,
    ...args: DeviceCallArgs<K>
  ): Promise<ToolInvocation<ToolResult<K>>>;
  /** Untyped escape hatch; device id keys are still injected schema-aware. */
  callUnchecked(name: string, params?: unknown): Promise<ToolInvocation>;
  /** The bound device id — resolves auto-detection on first use if needed. */
  deviceId(): Promise<string>;
}

export interface ArgentClient extends ArgentToolMethods, ArgentAliasMethods {
  /** Invoke a tool by id with full type checking. Sugar-free form of the per-tool methods. */
  call<K extends ToolName>(name: K, ...args: ToolCallArgs<K>): Promise<ToolResult<K>>;
  /** Like `call`, but returns the full envelope (data + note + materialized images). */
  invoke<K extends ToolName>(
    name: K,
    ...args: ToolCallArgs<K>
  ): Promise<ToolInvocation<ToolResult<K>>>;
  /**
   * Escape hatch for tools unknown to this SDK version (e.g. a newer remote
   * tool-server). No compile-time checking; the server still validates.
   */
  callUnchecked(name: string, params?: unknown): Promise<ToolInvocation>;
  /**
   * Bind a device so its id no longer needs to be passed on every call.
   * Without an argument, the single booted simulator/emulator is auto-detected
   * on first use (throws when none or several are booted).
   */
  device(id?: string): ArgentDevice;
  /** Tool metadata as served by GET /tools (includes JSON input schemas). */
  listTools(): Promise<ToolMeta[]>;
  /** Resolve (spawning if necessary) and return the tool-server base URL. */
  serverUrl(): Promise<string>;
  /**
   * Stop the locally auto-spawned tool-server, if one is running. The server
   * is shared across processes (MCP, CLI, other SDK instances) and idles out
   * on its own, so this is only needed for explicit teardown (e.g. CI).
   */
  stopServer(): Promise<void>;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export interface CreateArgentOptions {
  /**
   * Locations of the tool-server bundle and native binaries, needed to spawn a
   * local server. Defaults to the artifacts bundled with the published
   * package when present. Irrelevant when ARGENT_TOOLS_URL or `argent link`
   * routes to an already-running server.
   */
  paths?: ToolsServerPaths;
  /** Injection seam for tests. */
  client?: ToolsClient;
}

/**
 * Resolve the artifacts shipped inside the published @swmansion/argent package.
 * In the published layout this module is bundled to `dist/sdk.mjs`, next to
 * `dist/tool-server.cjs` with `bin/` and `dylibs/` one level up — the same
 * layout `packages/argent/src/bundled-paths.ts` relies on. Returns null in
 * unbundled dev checkouts, where callers pass `paths` or route via
 * ARGENT_TOOLS_URL instead.
 */
function defaultBundledPaths(): ToolsServerPaths | null {
  const dir = import.meta.dirname;
  const bundlePath = path.join(dir, "tool-server.cjs");
  if (!fs.existsSync(bundlePath)) return null;
  return {
    bundlePath,
    simulatorServerDir: path.join(dir, "..", "bin"),
    nativeDevtoolsDir: path.join(dir, "..", "dylibs"),
  };
}

// Properties the method Proxy must never fabricate a tool method for: returning
// a function from "then" would make the client thenable and break `await`.
const BLOCKED_PROPS = new Set(["then", "catch", "finally", "toJSON"]);

const CAMEL_METHOD_RE = /^[a-z][a-zA-Z0-9]*$/;

function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Wrap `base` in a Proxy that fabricates per-tool methods on demand:
 * camelCased property → kebab-case tool id (aliases first), dispatched via
 * `dispatch`. Shared by the plain client and device-bound handles.
 */
function proxyToolMethods<T extends object>(
  base: T,
  dispatch: (tool: string, params?: unknown) => Promise<unknown>
): T {
  const methodCache = new Map<string, (params?: unknown) => Promise<unknown>>();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      if (BLOCKED_PROPS.has(prop) || !CAMEL_METHOD_RE.test(prop)) {
        return undefined;
      }
      let method = methodCache.get(prop);
      if (!method) {
        const toolName =
          prop in TOOL_ALIASES
            ? TOOL_ALIASES[prop as keyof typeof TOOL_ALIASES]
            : camelToKebab(prop);
        method = (params?: unknown) => dispatch(toolName, params);
        methodCache.set(prop, method);
      }
      return method;
    },
  });
}

export function createArgent(options: CreateArgentOptions = {}): ArgentClient {
  // Resolved on first use so that importing the SDK (including the shared
  // `argent` export below) touches neither the filesystem nor the network.
  let clientInstance: ToolsClient | null = options.client ?? null;
  function client(): ToolsClient {
    clientInstance ??= createToolsClient({
      paths: options.paths ?? defaultBundledPaths() ?? undefined,
    });
    return clientInstance;
  }

  async function invokeByName(name: string, params: unknown): Promise<ToolInvocation> {
    const payload = (params ?? {}) as Record<string, unknown>;
    const resp = await client().callTool(name, payload);
    // Resolve artifact handles (screenshots, profiler exports) to local files,
    // mirroring what `argent run` and the MCP adapter do.
    const { url, token } = await client().baseUrl();
    const materialized = await materializeArtifacts(resp.data, {
      toolsUrl: url,
      authToken: token,
      deviceId: getDeviceIdFromArgs(payload),
    });
    return { data: materialized.result, note: resp.note, images: materialized.images };
  }

  // Tool metadata index, fetched once per client and shared by all device
  // handles — needed for schema-aware injection of device id keys.
  let toolMetaPromise: Promise<Map<string, ToolMeta>> | null = null;
  function toolMetaIndex(): Promise<Map<string, ToolMeta>> {
    toolMetaPromise ??= client()
      .fetchTools()
      .then((tools) => new Map(tools.map((t) => [t.name, t])));
    return toolMetaPromise;
  }

  function makeDevice(explicitId?: string): ArgentDevice {
    let resolvedId: Promise<string> | null =
      explicitId != null ? Promise.resolve(explicitId) : null;

    function deviceId(): Promise<string> {
      resolvedId ??= detectBootedDevice();
      return resolvedId;
    }

    async function detectBootedDevice(): Promise<string> {
      const { devices } = (await invokeByName("list-devices", {}))
        .data as ToolResult<"list-devices">;
      const booted = devices.filter((d) =>
        d.platform === "ios" ? d.state === "Booted" : d.state === "device"
      );
      const ids = booted.map((d) => (d.platform === "ios" ? d.udid : d.serial));
      if (booted.length === 0) {
        throw new Error(
          "argent.device(): no booted simulator/emulator found — boot one (e.g. with the boot-device tool) or pass a device id explicitly."
        );
      }
      if (booted.length > 1) {
        throw new Error(
          `argent.device(): ${booted.length} booted devices found (${ids.join(", ")}) — pass one explicitly.`
        );
      }
      return ids[0]!;
    }

    async function dispatchBound(tool: string, params?: unknown): Promise<ToolInvocation> {
      const meta = (await toolMetaIndex()).get(tool);
      const props = (meta?.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      const keys = props ? DEVICE_BIND_KEYS.filter((k) => k in props) : [];
      // Only resolve (and possibly auto-detect) the device when the tool
      // actually takes a device id; explicit caller params still win.
      const bound: Record<string, unknown> = {};
      if (keys.length > 0) {
        const id = await deviceId();
        for (const k of keys) bound[k] = id;
      }
      return invokeByName(tool, { ...bound, ...((params ?? {}) as object) });
    }

    const deviceBase = {
      call: (name: string, params?: unknown) => dispatchBound(name, params).then((r) => r.data),
      invoke: (name: string, params?: unknown) => dispatchBound(name, params),
      callUnchecked: (name: string, params?: unknown) => dispatchBound(name, params),
      deviceId,
    };
    return proxyToolMethods(deviceBase, (tool, params) =>
      dispatchBound(tool, params).then((r) => r.data)
    ) as unknown as ArgentDevice;
  }

  const base = {
    call: (name: string, params?: unknown) => invokeByName(name, params).then((r) => r.data),
    invoke: (name: string, params?: unknown) => invokeByName(name, params),
    callUnchecked: (name: string, params?: unknown) => invokeByName(name, params),
    device: (id?: string) => makeDevice(id),
    listTools: () => client().fetchTools(),
    serverUrl: () =>
      client()
        .baseUrl()
        .then(({ url }) => url),
    stopServer: () => killToolServer(),
  };

  return proxyToolMethods(base, (tool, params) =>
    invokeByName(tool, params).then((r) => r.data)
  ) as unknown as ArgentClient;
}

/**
 * Shared default client: `import { argent } from "@swmansion/argent"` and go.
 * Construction is lazy end to end — no server is spawned and no file is read
 * until the first tool call.
 */
export const argent: ArgentClient = createArgent();
