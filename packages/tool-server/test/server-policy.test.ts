import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import supertest from "supertest";
import { z } from "zod";
import { FAILURE_CODES, Registry, getFailureSignal, type ToolDefinition } from "@argent/registry";

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

import { createHttpApp, type HttpAppHandle } from "../src/http";
import {
  SERVER_POLICY_ENV,
  ServerPolicyConfigError,
  admitToolInvocation,
  assertPolicyToolsRegistered,
  installServerPolicy,
  loadServerPolicy,
  parseServerPolicy,
} from "../src/server-policy";
import { runFlowScriptStep } from "../src/tools/flows/flow-script-step";
import {
  DEVICE_BIND_KEYS,
  DEVICE_BIND_LIST_KEYS,
  DEVICE_LAUNCH_TARGET_KEYS,
} from "../src/utils/device-param-keys";
import { createRegistry } from "../src/utils/setup-registry";

const PINNED = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function install(raw: Record<string, unknown>) {
  installServerPolicy(parseServerPolicy({ version: 1, ...raw }, "/etc/argent/policy.json"));
}

/** The policy rule a refusal names, or undefined when the call is admitted. */
function deniedRule(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (err) {
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.SERVER_POLICY_DENIED);
    return signal?.failure_stage;
  }
}

afterEach(() => {
  installServerPolicy(undefined);
});

describe("server policy file", () => {
  it("is absent when ARGENT_SERVER_POLICY is unset", () => {
    expect(loadServerPolicy({})).toBeUndefined();
  });

  it("fails loading when the file cannot be read or parsed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "argent-policy-"));
    const broken = path.join(dir, "policy.json");
    writeFileSync(broken, "{ not json");

    expect(() => loadServerPolicy({ [SERVER_POLICY_ENV]: broken })).toThrow(
      ServerPolicyConfigError
    );
    expect(() => loadServerPolicy({ [SERVER_POLICY_ENV]: path.join(dir, "missing.json") })).toThrow(
      /cannot read policy JSON/
    );
  });

  it.each([
    [{ version: 2 }],
    [{ version: 1, extra: true }],
    [{ version: 1, devices: { allow: [] } }],
    [{ version: 1, tools: { allow: ["screenshot"], deny: ["boot-device"] } }],
    [{ version: 1, operations: { deny: ["device-erase"] } }],
  ])("rejects an invalid policy %j", (raw) => {
    expect(() => parseServerPolicy(raw, "/etc/argent/policy.json")).toThrow(
      ServerPolicyConfigError
    );
  });

  it("refuses a policy naming a tool the server does not register", () => {
    const policy = parseServerPolicy(
      { version: 1, tools: { deny: ["not-a-tool"] } },
      "/etc/argent/policy.json"
    );
    expect(() => assertPolicyToolsRegistered(policy, (id) => id === "screenshot")).toThrow(
      /"not-a-tool"/
    );
  });
});

describe("admission", () => {
  const registry = createRegistry();
  const tool = (id: string) => {
    const definition = registry.getTool(id);
    if (!definition) throw new Error(`missing tool ${id}`);
    return definition as ToolDefinition;
  };

  it("decides tools by an allow or a deny list", () => {
    install({ tools: { deny: ["boot-device"] } });
    expect(deniedRule(() => admitToolInvocation(tool("boot-device"), { udid: PINNED }))).toBe(
      "server_policy_tool"
    );
    expect(deniedRule(() => admitToolInvocation(tool("screenshot"), { udid: PINNED }))).toBe(
      undefined
    );

    install({ tools: { allow: ["screenshot"] } });
    expect(deniedRule(() => admitToolInvocation(tool("list-devices"), {}))).toBe(
      "server_policy_tool"
    );
  });

  it("refuses every device key that names a device outside the allowlist", () => {
    install({ devices: { allow: [PINNED] } });

    for (const args of [
      { udid: OTHER },
      { device_id: OTHER },
      { device: OTHER },
      { devices: [PINNED, OTHER] },
    ]) {
      expect(deniedRule(() => admitToolInvocation(tool("screenshot"), args))).toBe(
        "server_policy_device"
      );
    }
    expect(deniedRule(() => admitToolInvocation(tool("screenshot"), { udid: PINNED }))).toBe(
      undefined
    );
  });

  it("refuses launching a device by AVD, VVD image, or Electron path under an allowlist", () => {
    install({ devices: { allow: [PINNED] } });
    for (const args of [
      { avdName: "Pixel_9" },
      { vvdImage: "tv" },
      { electronAppPath: "/a.app" },
    ]) {
      expect(deniedRule(() => admitToolInvocation(tool("boot-device"), args))).toBe(
        "server_policy_device"
      );
    }
  });

  it("refuses the operations tools declare", () => {
    install({ operations: { deny: ["device-shutdown", "flow-scripts"] } });

    expect(
      deniedRule(() => admitToolInvocation(tool("boot-device"), { udid: PINNED, force: true }))
    ).toBe("server_policy_operation");
    expect(deniedRule(() => admitToolInvocation(tool("boot-device"), { udid: PINNED }))).toBe(
      undefined
    );
    expect(deniedRule(() => admitToolInvocation(tool("flow-add-script"), {}))).toBe(
      "server_policy_operation"
    );
  });

  it("refuses a flow script step when flow-scripts is denied", async () => {
    install({ operations: { deny: ["flow-scripts"] } });

    await expect(
      runFlowScriptStep({
        flowDir: "/flows",
        step: { kind: "script", path: "scripts/setup.mjs" } as never,
        projectRoot: "/project",
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("flow-scripts") });
  });

  // A new tool that names a device under another key would slip past the policy.
  it("reads every device key a tool schema declares", () => {
    const readKeys = new Set<string>([
      ...DEVICE_BIND_KEYS,
      ...DEVICE_BIND_LIST_KEYS,
      ...DEVICE_LAUNCH_TARGET_KEYS,
    ]);
    // Device-sounding keys that do not name a device id.
    const notDeviceIds = new Set(["electronPort", "electronArgs"]);
    const unread: string[] = [];
    for (const definition of registry.getSnapshot().tools.map((id) => tool(id))) {
      const props = (definition.inputSchema as { properties?: Record<string, unknown> })
        ?.properties;
      for (const key of Object.keys(props ?? {})) {
        if (!/udid|device|serial|avd|vvd|electron/i.test(key)) continue;
        if (!readKeys.has(key) && !notDeviceIds.has(key)) unread.push(`${definition.id}.${key}`);
      }
    }
    expect(unread).toEqual([]);
  });
});

describe("HTTP and nested dispatch", () => {
  let handle: HttpAppHandle | undefined;

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
  });

  function harness() {
    const registry = new Registry({ admitInvocation: admitToolInvocation });
    const deviceExecute = vi.fn(async () => ({ ok: true }));
    registry.registerTool({
      id: "stub-device",
      description: "acts on a device",
      zodSchema: z.object({ udid: z.string() }),
      services: () => ({}),
      execute: deviceExecute,
    });
    registry.registerTool<{ udid: string; target: string }>({
      id: "stub-nested",
      description: "acts on another device through the registry, like a flow step",
      zodSchema: z.object({ udid: z.string(), target: z.string() }),
      services: () => ({}),
      execute: async (_services, params) =>
        registry.invokeTool("stub-device", { udid: params.target }),
    });
    handle = createHttpApp(registry);
    return { app: handle.app, deviceExecute };
  }

  it("refuses a device outside the allowlist with 403 before the tool runs", async () => {
    install({ devices: { allow: [PINNED] } });
    const { app, deviceExecute } = harness();

    const res = await supertest(app).post("/tools/stub-device").send({ udid: OTHER });

    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe(FAILURE_CODES.SERVER_POLICY_DENIED);
    expect(deviceExecute).not.toHaveBeenCalled();
  });

  it("admits a nested invocation again in the registry", async () => {
    install({ devices: { allow: [PINNED] } });
    const { app, deviceExecute } = harness();

    const res = await supertest(app)
      .post("/tools/stub-nested")
      .send({ udid: PINNED, target: OTHER });

    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe(FAILURE_CODES.SERVER_POLICY_DENIED);
    expect(deviceExecute).not.toHaveBeenCalled();
  });

  it("admits everything when no policy is installed", async () => {
    const { app, deviceExecute } = harness();

    const res = await supertest(app).post("/tools/stub-device").send({ udid: OTHER });

    expect(res.status).toBe(200);
    expect(deviceExecute).toHaveBeenCalledOnce();
  });

  it("refuses the Chromium passthrough for a device outside the allowlist", async () => {
    install({ devices: { allow: [PINNED] } });
    const { app } = harness();

    const res = await supertest(app).get("/chromium-server/chromium-cdp-9222/json");

    expect(res.status).toBe(403);
  });
});
