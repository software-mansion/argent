import type { ServiceRef, ToolDefinition } from "@argent/registry";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { debuggerComponentTreeTool } from "../src/tools/debugger/debugger-component-tree";
import { debuggerConnectTool } from "../src/tools/debugger/debugger-connect";
import { debuggerInspectElementTool } from "../src/tools/debugger/debugger-inspect-element";
import { debuggerReloadMetroTool } from "../src/tools/debugger/debugger-reload-metro";
import { networkLogsTool } from "../src/tools/network/network-logs";
import { networkRequestTool } from "../src/tools/network/network-request";
import { reactProfilerFiberTreeTool } from "../src/tools/profiler/react/react-profiler-fiber-tree";
import { reactProfilerRendersTool } from "../src/tools/profiler/react/react-profiler-renders";
import { forgetDeviceAlias, rememberDeviceAlias } from "../src/utils/debugger/device-alias";
import { metroPort, publishedMetroPort } from "../src/utils/debugger/metro-port";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";

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
const PROVIDER_ID = "acme-3f2a9c";
const PROVIDER_METRO_PORT = 54321;
const DEVICE_ID = makeExternalId(PROVIDER_ID, ANDROID_SERIAL);

let temporaryDirectory: string;

/**
 * Publish a descriptor whose device declares `metroPort` unless told not to.
 */
function publishDescriptor(options: { metroPort?: number } = {}): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
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
    expect(metroPort({ device_id: ANDROID_SERIAL })).toBe(8081);
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
    expect(publishedMetroPort(ANDROID_SERIAL, 8081)).toBeUndefined();
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
