import type { ServiceRef, ToolDefinition } from "@argent/registry";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { debuggerConnectTool } from "../src/tools/debugger/debugger-connect";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import {
  debuggerReapedScope,
  debuggerServiceRef,
} from "../src/tools/debugger/debugger-service-ref";
import { networkLogsTool } from "../src/tools/network/network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { reactProfilerFiberTreeTool } from "../src/tools/profiler/react/react-profiler-fiber-tree";
import { reactProfilerRendersTool } from "../src/tools/profiler/react/react-profiler-renders";
import { forgetDeviceAlias, rememberDeviceAlias } from "../src/utils/debugger/device-alias";
import {
  isResolvedMetroPort,
  metroPort,
  metroPortWasResolved,
  publishedMetroPort,
} from "../src/utils/debugger/metro-port";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";
import {
  __resetReapedSessionsForTesting,
  recordReapedSession,
  takeReapedSession,
} from "../src/utils/reaped-sessions";

/**
 * A provider running several projects gives each a free port, so an agent
 * cannot guess it. The descriptor's `metroPort` supplies the default instead.
 *
 * `(port, device_id)` is a session key, naming the CDP service in its URN and
 * the captured profile on disk. Two tools deriving it differently do not fail,
 * they address different sessions. `debugger-connect` opens the app and
 * `debugger-evaluate` finds nothing. Hence the invariant at the bottom.
 */

const ANDROID_SERIAL = "emulator-5554";
/** A serial no descriptor claims, the device argent booted for itself. */
const UNCLAIMED_SERIAL = "emulator-5556";
const PROVIDER_ID = "acme-3f2a9c";
const PROVIDER_METRO_PORT = 54321;
const DEVICE_ID = makeExternalId(PROVIDER_ID, ANDROID_SERIAL);
const KEPT_LOG = "/tmp/argent-logs-1-2-3-4.log";

let temporaryDirectory: string;

/**
 * Publish a descriptor whose device declares `metroPort` unless told not to.
 */
function publishDescriptor(options: { metroPort?: number; devices?: unknown[] } = {}): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: options.devices ?? [
        {
          capabilities: ["adb", "js-debugger"],
          kind: "emulator",
          ...(options.metroPort === undefined ? {} : { metroPort: options.metroPort }),
          name: "Pixel 9",
          nativeId: ANDROID_SERIAL,
          platform: "android",
          state: "device",
        },
      ],
      id: PROVIDER_ID,
      name: "Acme IDE",
      schemaVersion: 1,
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-metro-port-"));
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
  __resetReapedSessionsForTesting();
  publishDescriptor({ metroPort: PROVIDER_METRO_PORT });
});

afterEach(() => {
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
});

describe("metroPort", () => {
  it("takes the port the device's provider publishes", () => {
    expect(metroPort({ device_id: DEVICE_ID })).toBe(PROVIDER_METRO_PORT);
  });

  it("lets an explicit port win, so a second bundler stays addressable", () => {
    expect(metroPort({ device_id: DEVICE_ID, port: 9000 })).toBe(9000);
  });

  it("falls back to 8081 when the provider publishes no port", () => {
    publishDescriptor();
    expect(metroPort({ device_id: DEVICE_ID })).toBe(8081);
  });

  it("falls back to 8081 for a device argent booted itself", () => {
    expect(metroPort({ device_id: UNCLAIMED_SERIAL })).toBe(8081);
  });

  /**
   * The grant and the published port bind to the device, not to one of its
   * names. A caller naming the provider's emulator the way `adb devices` does
   * has to reach the same Metro as one naming it `ext:...` or the debugger
   * dials 8081 while the app is served from the provider's port.
   */
  it("takes the provider's port for the raw serial it claims", () => {
    expect(metroPort({ device_id: ANDROID_SERIAL })).toBe(PROVIDER_METRO_PORT);
  });

  it("tolerates a missing device id", () => {
    expect(metroPort({})).toBe(8081);
  });

  /**
   * `debugger-connect` hands back Metro's own per-connection handle and a
   * caller is free to forward it. It resolves to the same service (that is what
   * the alias map is for), so it has to resolve to the same port too.
   */
  it("resolves the provider through a forwarded logicalDeviceId", () => {
    rememberDeviceAlias("metro-logical-1", DEVICE_ID);

    try {
      expect(metroPort({ device_id: "metro-logical-1" })).toBe(PROVIDER_METRO_PORT);
    } finally {
      forgetDeviceAlias("metro-logical-1");
    }
  });
});

describe("publishedMetroPort", () => {
  it("reports the provider's port when the call is using a different one", () => {
    expect(publishedMetroPort(DEVICE_ID, 8081)).toBe(PROVIDER_METRO_PORT);
  });

  it("says nothing when the call already uses the published port", () => {
    expect(publishedMetroPort(DEVICE_ID, PROVIDER_METRO_PORT)).toBeUndefined();
  });

  it("says nothing about a device with no provider", () => {
    expect(publishedMetroPort(UNCLAIMED_SERIAL, 8081)).toBeUndefined();
  });

  it("reports the provider's port for the raw serial it claims", () => {
    expect(publishedMetroPort(ANDROID_SERIAL, 8081)).toBe(PROVIDER_METRO_PORT);
  });
});

/**
 * These tools do not share a URN builder: three predate `debuggerServiceRef`
 * and interpolate the pair themselves. So this drives each one's real
 * `services()` rather than the helper.
 */
const URN_TOOLS: {
  name: string;
  params: Record<string, unknown>;
  tool: ToolDefinition<any, any>;
}[] = [
  { name: "debugger-component-tree", params: {}, tool: debuggerComponentTreeTool },
  { name: "debugger-connect", params: {}, tool: debuggerConnectTool },
  { name: "debugger-inspect-element", params: { x: 1, y: 1 }, tool: debuggerInspectElementTool },
  { name: "debugger-reload-metro", params: {}, tool: debuggerReloadMetroTool },
  { name: "react-profiler-fiber-tree", params: {}, tool: reactProfilerFiberTreeTool },
  { name: "react-profiler-renders", params: {}, tool: reactProfilerRendersTool },
  { name: "view-network-logs", params: {}, tool: networkLogsTool },
  { name: "view-network-request-details", params: { requestId: "1" }, tool: networkRequestTool },
];

function urnsFor(tool: ToolDefinition<any, any>, params: Record<string, unknown>): string[] {
  const parsed = tool.zodSchema!.parse({ device_id: DEVICE_ID, ...params });

  return Object.values(tool.services(parsed) as Record<string, ServiceRef>).map((ref) =>
    typeof ref === "string" ? ref : ref.urn
  );
}

describe("service URNs for a provider's device", () => {
  it.each(URN_TOOLS)("$name keys its session on the published port", ({ params, tool }) => {
    const urns = urnsFor(tool, params);

    expect(urns.length).toBeGreaterThan(0);

    for (const urn of urns) {
      expect(urn).toContain(`:${PROVIDER_METRO_PORT}:`);
      expect(urn).not.toContain(":8081:");
    }
  });

  it.each(URN_TOOLS)("$name still honours an explicit port", ({ params, tool }) => {
    for (const urn of urnsFor(tool, { ...params, port: 9000 })) {
      expect(urn).toContain(":9000:");
    }
  });
});

/**
 * The reaped-session store is keyed on the port TEXT the blueprint slices out
 * of the URN, so a reader that resolves the port differently from the ref files
 * and looks under two different scopes: the crash note is filed, and the read
 * that should report it finds nothing.
 */
describe("debuggerReapedScope agrees with the URN the session is named by", () => {
  function urnPort(params: { device_id: string; port?: number }): string {
    const ref = debuggerServiceRef(params);
    const urn = typeof ref === "string" ? ref : ref.urn;

    return urn.split(":")[1];
  }

  it("takes the published port when the caller names none", () => {
    expect(debuggerReapedScope({ device_id: DEVICE_ID })).toBe(String(PROVIDER_METRO_PORT));
    expect(debuggerReapedScope({ device_id: DEVICE_ID })).toBe(urnPort({ device_id: DEVICE_ID }));
  });

  it("takes the caller's port over the published one", () => {
    expect(debuggerReapedScope({ device_id: DEVICE_ID, port: 9000 })).toBe("9000");
  });

  it("falls back to 8081 for a device no provider claims", () => {
    expect(debuggerReapedScope({ device_id: UNCLAIMED_SERIAL })).toBe(
      urnPort({ device_id: UNCLAIMED_SERIAL })
    );
    expect(debuggerReapedScope({ device_id: UNCLAIMED_SERIAL })).toBe("8081");
  });

  /** Chromium carries its CDP port inside the device id, so it stays unscoped. */
  it("leaves a Chromium session unscoped", () => {
    expect(debuggerReapedScope({ device_id: "chromium-cdp-9222" })).toBeUndefined();
  });

  /**
   * The write-side half of the gate: whether a session's port is the one an
   * unnamed call resolves, which is what decides if a later such call may
   * address it by a different port. It turns on the port, not on who gave it.
   */
  describe("isResolvedMetroPort", () => {
    it("holds for the provider's port, however the caller supplied it", () => {
      expect(isResolvedMetroPort(DEVICE_ID, PROVIDER_METRO_PORT)).toBe(true);
    });

    it("holds for the 8081 default on a device nothing claims", () => {
      // The port still moves the moment a provider claims the device, so a
      // session on it is one a later unnamed read may look for elsewhere.
      expect(isResolvedMetroPort(UNCLAIMED_SERIAL, 8081)).toBe(true);
    });

    it("fails for a port resolution would not have picked", () => {
      // A second bundler on a device a descriptor DOES claim: the discriminating
      // case, and the one that must never be forgiven.
      expect(isResolvedMetroPort(DEVICE_ID, 9000)).toBe(false);
      expect(isResolvedMetroPort(UNCLAIMED_SERIAL, 9000)).toBe(false);
    });
  });

  it("keeps the breadcrumb when a provider starts publishing a port", () => {
    // The device is claimed by nothing, so an unnamed call resolves 8081 and the
    // session runs there. A provider then claims it and publishes its own port,
    // and the identical read resolves that instead — the same key move as a
    // withdrawal, with no provider involved when the record was filed.
    publishDescriptor({ devices: [] });
    const params = { device_id: ANDROID_SERIAL };
    const filedScope = debuggerReapedScope(params);
    expect(filedScope).toBe("8081");

    recordReapedSession("js-runtime-debugger", [ANDROID_SERIAL], "kept", {
      cause: "runtime-death",
      keptAt: KEPT_LOG,
      scope: filedScope,
      scopeWasResolved: isResolvedMetroPort(ANDROID_SERIAL, 8081),
    });

    publishDescriptor({ metroPort: PROVIDER_METRO_PORT });

    const readerScope = debuggerReapedScope(params);
    expect(readerScope).toBe(String(PROVIDER_METRO_PORT));
    expect(
      takeReapedSession("js-runtime-debugger", ANDROID_SERIAL, readerScope, {
        scopeResolved: metroPortWasResolved(params),
      })?.keptAt
    ).toBe(KEPT_LOG);
  });

  /**
   * The agreement above holds at one instant. The scope is resolved, not
   * remembered, so the provider withdrawing the device moves what an unchanged
   * call computes — and that withdrawal is itself one of the teardowns that
   * files a breadcrumb, so the read that misses is the one chasing the crash it
   * caused. Losing it would have the registry report no session was lost while
   * holding the only path to the pre-crash log.
   */
  it("still reaches the breadcrumb after the provider drops the device", () => {
    const params = { device_id: DEVICE_ID };
    const filedScope = debuggerReapedScope(params);
    expect(filedScope).toBe(urnPort(params));

    recordReapedSession("js-runtime-debugger", [DEVICE_ID], "kept", {
      cause: "runtime-death",
      keptAt: KEPT_LOG,
      scope: filedScope,
      // What the blueprint records, read while the claim is still live.
      scopeWasResolved: isResolvedMetroPort(DEVICE_ID, PROVIDER_METRO_PORT),
    });

    publishDescriptor({ devices: [] });

    const readerScope = debuggerReapedScope(params);
    expect(readerScope).not.toBe(filedScope);
    expect(
      takeReapedSession("js-runtime-debugger", DEVICE_ID, readerScope, {
        scopeResolved: metroPortWasResolved(params),
      })?.keptAt
    ).toBe(KEPT_LOG);
  });
});

/**
 * The type system covers value call sites, since `port` is optional and
 * reading it raw is a compile error. It does not cover URN builders,
 * `${params.port}` interpolates `undefined` happily and keys the session on
 * that string. This is the backstop and for any tool added later that
 * declares the pair.
 */
describe("no tool reads the raw port", () => {
  const toolsRoot = path.join(__dirname, "..", "src", "tools");

  function sourceFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    });
  }

  const metroSessionTools = sourceFiles(toolsRoot)
    .map((file) => ({ file, source: fs.readFileSync(file, "utf8") }))
    .filter(({ source }) => /^\s*port: /m.test(source) && /^\s*device_id: /m.test(source));

  it("finds the tools that key a session on (port, device_id)", () => {
    // A rename that silently empties the list would make every case below vacuous.
    expect(metroSessionTools.length).toBeGreaterThanOrEqual(20);
  });

  it.each(metroSessionTools)("$file declares the shared port field", ({ source }) => {
    expect(source).toContain("port: metroPortField,");
  });

  it.each(metroSessionTools)("$file resolves the port before using it", ({ source }) => {
    expect(source).not.toMatch(/params\.port/);
  });
});
