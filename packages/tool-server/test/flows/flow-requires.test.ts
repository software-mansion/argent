import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import {
  parseFlow,
  serializeFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

// Probed for an explicit device and for a listed device with no runtime kind.
const runtimeKinds = new Map<string, "mobile" | "tv">();
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSimulatorRuntimeKind: vi.fn(async (udid: string) => runtimeKinds.get(udid)),
}));
vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAndroidRuntimeKind: vi.fn(async (serial: string) => runtimeKinds.get(serial)),
}));

const IOS = "00000000-0000-0000-0000-0000000000ab";
const IOS_TV = "00000000-0000-0000-0000-0000000000cd";
const ANDROID = "emulator-5554";

let tmpDir: string;

interface ListedDevice {
  platform: string;
  state: string;
  udid?: string;
  serial?: string;
  runtimeKind?: "mobile" | "tv";
}

function mockRegistry(booted: ListedDevice[] = []) {
  const invokeTool = vi.fn(async (id: string) => {
    if (id === "list-devices") return { devices: booted };
    return { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn((name: string) => ({
      inputSchema: { properties: name === CLEANUP.name ? { devices: {} } : { udid: {} } },
    })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

const ios = (udid: string, runtimeKind?: "mobile" | "tv"): ListedDevice => ({
  platform: "ios",
  state: "Booted",
  udid,
  ...(runtimeKind ? { runtimeKind } : {}),
});
const android = (serial: string, runtimeKind?: "mobile" | "tv"): ListedDevice => ({
  platform: "android",
  state: "device",
  serial,
  ...(runtimeKind ? { runtimeKind } : {}),
});

const TAP: FlowStep = { kind: "tool", name: "tap", args: {} };
const CLEANUP = { kind: "tool", name: "stop-all-simulator-servers", args: {} } satisfies FlowStep;

async function writeFlow(name: string, flow: Partial<FlowFile>): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "e2e");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps: [TAP], ...flow }),
    "utf8"
  );
}

async function run(
  registry: Registry,
  name: string,
  params: Record<string, unknown> = {}
): Promise<FlowRunResult> {
  const result = await createRunFlowTool(registry).execute(
    {},
    { name, project_root: tmpDir, ...params }
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result;
}

async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return getFailureSignal(err)?.error_code;
  }
  throw new Error("expected the run to throw");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-requires-"));
  runtimeKinds.clear();
  runtimeKinds.set(IOS, "mobile");
  runtimeKinds.set(IOS_TV, "tv");
  runtimeKinds.set(ANDROID, "mobile");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parsing a requires block", () => {
  it("is absent by default", () => {
    expect(parseFlow("steps: [{ echo: hi }]").requires).toBeUndefined();
  });

  it("normalizes a bare platform to a list", () => {
    expect(parseFlow("requires: { platform: ios }\nsteps: []").requires).toEqual({
      platform: ["ios"],
    });
  });

  it("round-trips through serialize", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      requires: { platform: ["ios", "android"], runtimeKind: "tv" },
      steps: [{ kind: "echo", message: "hi" }],
    };
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it("writes the block above the steps, with one platform as a plain value", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      requires: { platform: ["ios"] },
      steps: [{ kind: "echo", message: "hi" }],
    });
    expect(yaml).toMatch(/^requires:\n {2}platform: ios\nsteps:/);
  });

  it.each([
    ["requires: { platfrom: ios }", /unknown key `platfrom`/],
    ["require: { platform: ios }", /unknown key `require`/],
    ["requires: {}", /must declare at least one of platform, runtimeKind/],
    ["requires: [ios]", /requires must be a map/],
    ["requires: { platform: [] }", /must name at least one of/],
    ["requires: { platform: [ios, windows] }", /requires.platform must be one of/],
    ["requires: { platform: ios-remote }", /requires.platform must be one of/],
    ["requires: { runtimeKind: tablet }", /requires.runtimeKind must be one of mobile, tv/],
  ])("rejects %s", (block, message) => {
    expect(() => parseFlow(`${block}\nsteps: []`)).toThrow(message);
  });
});

describe("an explicitly targeted run", () => {
  it("fails with FLOW_REQUIREMENTS_UNMET when the device's platform is excluded", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry, invokeTool } = mockRegistry();
    expect(await failureCode(run(registry, "ios-only", { device: ANDROID }))).toBe(
      FAILURE_CODES.FLOW_REQUIREMENTS_UNMET
    );
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("probes an explicit device before the prerequisite handshake", async () => {
    await writeFlow("tv-fragment", {
      executionPrerequisite: "logged in",
      requires: { runtimeKind: "tv" },
    });
    const { registry } = mockRegistry();
    expect(await failureCode(run(registry, "tv-fragment", { device: IOS }))).toBe(
      FAILURE_CODES.FLOW_REQUIREMENTS_UNMET
    );
  });

  it("reports an invalid file rather than a skip when the target is also excluded", async () => {
    await writeFlow("starts-app", { steps: [{ kind: "launch", app: "com.example.app" }] });
    await writeFlow("broken", {
      executionPrerequisite: "logged in",
      requires: { platform: ["ios"] },
      steps: [{ kind: "run", flow: "starts-app" }],
    });
    const { registry } = mockRegistry();
    expect(await failureCode(run(registry, "broken", { platform: "android" }))).toBe(
      FAILURE_CODES.FLOW_E2E_HAS_PREREQUISITE
    );
  });

  it("fails before the prerequisite handshake when the platform param is excluded", async () => {
    await writeFlow("ios-fragment", {
      executionPrerequisite: "logged in",
      requires: { platform: ["ios"] },
    });
    const { registry } = mockRegistry();
    expect(await failureCode(run(registry, "ios-fragment", { platform: "android" }))).toBe(
      FAILURE_CODES.FLOW_REQUIREMENTS_UNMET
    );
  });

  it("counts a remote simulator as ios", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry();
    const result = await run(registry, "ios-only", {
      device: "remote:00000000-0000-0000-0000-0000000000ef",
    });
    expect(result.ok).toBe(true);
  });

  it("fails when the device is not the required runtime kind", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry();
    await expect(run(registry, "tv-only", { device: IOS })).rejects.toThrow(
      `excludes device ${IOS} (ios, mobile)`
    );
    expect((await run(registry, "tv-only", { device: IOS_TV })).ok).toBe(true);
  });

  it("probes an external Android device by its native serial", async () => {
    await writeFlow("mobile-only", { requires: { runtimeKind: "mobile" } });
    const { registry } = mockRegistry();
    const result = await run(registry, "mobile-only", { device: `ext:prov:${ANDROID}` });
    expect(result.ok).toBe(true);
  });

  it("fails without the skip code when the runtime kind cannot be read", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    runtimeKinds.delete(ANDROID);
    const { registry } = mockRegistry();
    expect(await failureCode(run(registry, "tv-only", { device: ANDROID }))).toBe(
      FAILURE_CODES.FLOW_DEVICE_RESOLUTION
    );
  });
});

describe("requirements narrow device auto-detection", () => {
  it("picks the one booted device that matches instead of failing as ambiguous", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([android(ANDROID), ios(IOS)]);
    expect((await run(registry, "ios-only")).device).toBe(IOS);
  });

  it("picks by the runtime kind the listing reports", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([ios(IOS, "mobile"), ios(IOS_TV, "tv")]);
    expect((await run(registry, "tv-only")).device).toBe(IOS_TV);
  });

  it("fails with FLOW_REQUIREMENTS_UNMET when no booted device matches", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([ios(IOS, "mobile"), android(ANDROID, "mobile")]);
    const err = await run(registry, "tv-only").catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
    expect((err as Error).message).toContain(
      `Booted devices: ${IOS} (ios, mobile), ${ANDROID} (android, mobile).`
    );
  });

  it("fails without the skip code when a candidate's runtime kind is unknown", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    runtimeKinds.delete(ANDROID);
    const { registry } = mockRegistry([ios(IOS_TV, "tv"), android(ANDROID)]);
    const err = await run(registry, "tv-only").catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_DEVICE_RESOLUTION);
    expect((err as Error).message).toContain(`runtime kind of ${ANDROID} (android, device)`);
  });

  it("probes a candidate whose listing has no runtime kind", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    runtimeKinds.set(ANDROID, "tv");
    const { registry } = mockRegistry([ios(IOS, "mobile"), android(ANDROID)]);
    expect((await run(registry, "tv-only")).device).toBe(ANDROID);
  });

  it("fails a cleanup test rather than sweeping unscoped when a runtime kind is unknown", async () => {
    await writeFlow("tv-cleanup", { requires: { runtimeKind: "tv" }, steps: [CLEANUP] });
    runtimeKinds.delete(ANDROID);
    const { registry, invokeTool } = mockRegistry([ios(IOS_TV, "tv"), android(ANDROID)]);
    expect(await failureCode(run(registry, "tv-cleanup"))).toBe(
      FAILURE_CODES.FLOW_DEVICE_RESOLUTION
    );
    expect(invokeTool).not.toHaveBeenCalledWith(CLEANUP.name, expect.anything());
  });

  it("still reports no device when nothing is booted", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([]);
    expect(await failureCode(run(registry, "ios-only"))).toBe(FAILURE_CODES.FLOW_DEVICE_RESOLUTION);
  });
});

describe("a run: fragment with requirements", () => {
  it("errors the run: step when the run device does not meet them", async () => {
    await writeFlow("android-part", { requires: { platform: ["android"] } });
    await writeFlow("root", { steps: [{ kind: "run", flow: "android-part" }, TAP] });
    const { registry } = mockRegistry([ios(IOS)]);
    const result = await run(registry, "root");
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "run", status: "error" });
    expect(result.steps[0].reason).toMatch(
      /^Fragment "android-part.yaml" declares requires: \{ platform: \[android\] \}, which excludes device /
    );
  });

  it("runs when the run device meets them", async () => {
    await writeFlow("ios-part", { requires: { platform: ["ios"] } });
    await writeFlow("root", { steps: [{ kind: "run", flow: "ios-part" }] });
    const { registry } = mockRegistry([ios(IOS)]);
    expect((await run(registry, "root")).ok).toBe(true);
  });
});
