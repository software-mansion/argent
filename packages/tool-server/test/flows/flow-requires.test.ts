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

// The explicit-device path probes the runtime kind through these three; the
// auto-detect path reads it off the `list-devices` payload instead and needs
// no mock. Spread the originals so the rest of each module keeps working — the
// runner reaches into them for unrelated reasons.
const runtimeKinds = new Map<string, "mobile" | "tv">();
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSimulatorRuntimeKind: vi.fn(async (udid: string) => runtimeKinds.get(udid)),
}));
vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAndroidRuntimeKind: vi.fn(async (serial: string) => runtimeKinds.get(serial)),
}));
vi.mock("../../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRemoteSimulatorRuntimeKind: vi.fn(async (udid: string) => runtimeKinds.get(udid)),
}));

const IOS = "00000000-0000-0000-0000-0000000000ab";
const IOS_TV = "00000000-0000-0000-0000-0000000000cd";
const IOS_REMOTE = "remote:00000000-0000-0000-0000-0000000000ef";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";

let tmpDir: string;

interface ListedDevice {
  platform: string;
  state: string;
  udid?: string;
  serial?: string;
  id?: string;
  runtimeKind?: "mobile" | "tv";
}

function mockRegistry(booted: ListedDevice[] = []) {
  const invokeTool = vi.fn(async (id: string) => {
    if (id === "list-devices") return { devices: booted };
    return { ok: true };
  });
  const registry = {
    invokeTool,
    // Every tool step in these flows takes a udid, so it counts as needing a
    // device — the case where requirements actually bite.
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

const iosEntry = (udid: string, runtimeKind?: "mobile" | "tv"): ListedDevice => ({
  platform: "ios",
  state: "Booted",
  udid,
  ...(runtimeKind ? { runtimeKind } : {}),
});
const androidEntry = (serial: string, runtimeKind?: "mobile" | "tv"): ListedDevice => ({
  platform: "android",
  state: "device",
  serial,
  ...(runtimeKind ? { runtimeKind } : {}),
});

/** A single step that needs a device and always succeeds. */
const OK_STEP: FlowStep = { kind: "tool", name: "tap", args: {} };

async function writeFlow(name: string, flow: Partial<FlowFile>): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps: [OK_STEP], ...flow }),
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-requires-"));
  runtimeKinds.clear();
  runtimeKinds.set(IOS, "mobile");
  runtimeKinds.set(IOS_TV, "tv");
  runtimeKinds.set(IOS_REMOTE, "mobile");
  runtimeKinds.set(ANDROID, "mobile");
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parsing a requires block", () => {
  const parse = (yaml: string): FlowFile => parseFlow(yaml);

  it("is absent by default, so an existing flow runs anywhere", () => {
    expect(parse("steps: [{ echo: hi }]").requires).toBeUndefined();
  });

  it("normalizes a bare platform to a list", () => {
    expect(parse("requires: { platform: ios }\nsteps: [{ echo: hi }]").requires).toEqual({
      platform: ["ios"],
    });
  });

  it("accepts a platform list and a runtime kind together", () => {
    const flow = parse("requires: { platform: [ios, android], runtimeKind: tv }\nsteps: []");
    expect(flow.requires).toEqual({ platform: ["ios", "android"], runtimeKind: "tv" });
  });

  it("round-trips through serialize", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      requires: { platform: ["ios", "android"], runtimeKind: "tv" },
      steps: [{ kind: "echo", message: "hi" }],
    };
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it("names a misspelled key rather than silently running everywhere", () => {
    expect(() => parse("requires: { platfrom: ios }\nsteps: []")).toThrow(
      /unknown key `platfrom` \(did you mean `platform`\?\)/
    );
  });

  it("rejects a misspelled top-level requires", () => {
    expect(() => parse("require: { platform: ios }\nsteps: []")).toThrow(/unknown key `require`/);
  });

  it("rejects an empty block, which declares nothing", () => {
    expect(() => parse("requires: {}\nsteps: []")).toThrow(/must declare at least one of/);
  });

  it("rejects an empty platform list", () => {
    expect(() => parse("requires: { platform: [] }\nsteps: []")).toThrow(/at least one of/);
  });

  it("rejects an unknown platform", () => {
    expect(() => parse("requires: { platform: [ios, windows] }\nsteps: []")).toThrow(
      /requires.platform must be one of/
    );
  });

  it("rejects a repeated platform", () => {
    expect(() => parse("requires: { platform: [ios, ios] }\nsteps: []")).toThrow(
      /lists "ios" twice/
    );
  });

  it("rejects an unknown runtime kind", () => {
    expect(() => parse("requires: { runtimeKind: tablet }\nsteps: []")).toThrow(
      /requires.runtimeKind must be one of mobile, tv/
    );
  });

  it("classifies its parse errors as an invalid file, like the top-level-key check", () => {
    // `requires` is a top-level key, not a step: the step-shaped
    // FLOW_ENTRY_UNRECOGNIZED / flow_file_parse_step classification would point
    // prose and telemetry at a step that does not exist.
    for (const yaml of [
      "requires: {}\nsteps: []",
      "requires: { platform: [windows] }\nsteps: []",
    ]) {
      let err: unknown;
      try {
        parse(yaml);
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toMatch(/^Invalid flow file:/);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
      expect(getFailureSignal(err)?.failure_stage).toBe("flow_file_parse");
    }
  });
});

describe("requirements no target could satisfy are rejected at parse", () => {
  it("refuses a tv requirement on chromium alone", () => {
    expect(() =>
      parseFlow("requires: { platform: [chromium], runtimeKind: tv }\nsteps: []")
    ).toThrow(/can never be satisfied.*chromium never is/s);
  });

  it("refuses a mobile requirement on vega alone", () => {
    expect(() =>
      parseFlow("requires: { platform: [vega], runtimeKind: mobile }\nsteps: []")
    ).toThrow(/can never be satisfied/);
  });

  it("allows the combination when one named platform can present the kind", () => {
    // chromium can't be a TV, but ios can — the flow is runnable on an Apple TV.
    expect(
      parseFlow("requires: { platform: [ios, chromium], runtimeKind: tv }\nsteps: []").requires
    ).toEqual({ platform: ["ios", "chromium"], runtimeKind: "tv" });
  });

  it("judges launch coverage only over the platforms the runtime kind leaves viable", () => {
    // vega is always tv, so a mobile requirement never reaches it — the launch
    // owes it no app id.
    expect(() =>
      parseFlow(
        "requires: { platform: [ios, android, vega], runtimeKind: mobile }\n" +
          "steps: [{ launch: { ios: com.a, android: com.a } }]"
      )
    ).not.toThrow();
  });

  it("keeps the blessed mixed combination legal once a launch step exists", () => {
    // Only ios can be a TV here, and `native` covers it; chromium owes nothing.
    expect(() =>
      parseFlow(
        "requires: { platform: [ios, chromium], runtimeKind: tv }\n" +
          "steps: [{ launch: { native: com.a } }]"
      )
    ).not.toThrow();
  });

  it("refuses a runtime-kind-only block whose launches serve no platform of that kind", () => {
    // chromium is always mobile, so no tv target anywhere can run this file —
    // without the check it would parse clean and then skip silently forever.
    let err: unknown;
    try {
      parseFlow("requires: { runtimeKind: tv }\nsteps: [{ launch: { chromium: /some/app } }]");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/can never be satisfied/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIRES_UNSATISFIABLE);
  });

  it("allows a runtime-kind-only block when a shared native id serves a viable platform", () => {
    expect(() =>
      parseFlow("requires: { runtimeKind: tv }\nsteps: [{ launch: { native: com.a } }]")
    ).not.toThrow();
  });

  it("refuses a launch declaring no app id for a required platform", () => {
    expect(() =>
      parseFlow("requires: { platform: [ios, android] }\nsteps: [{ launch: { ios: com.a } }]")
    ).toThrow(/declares no app id for android/);
  });

  it("accepts a bare-string launch, which covers every platform", () => {
    expect(() =>
      parseFlow("requires: { platform: [ios, android] }\nsteps: [{ launch: com.a }]")
    ).not.toThrow();
  });

  it("judges a guarded launch against its guard's platform only", () => {
    // An ios-only launch behind an ios guard is unreachable on android, so it
    // is not a contradiction in a flow that also supports android.
    expect(() =>
      parseFlow(
        [
          "requires: { platform: [ios, android] }",
          "steps:",
          "  - when: { platform: ios }",
          "    steps: [{ launch: { ios: com.a } }]",
        ].join("\n")
      )
    ).not.toThrow();
  });
});

describe("an explicitly targeted run", () => {
  it("fails when the device's platform is excluded", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry();

    await expect(run(registry, "ios-only", { device: ANDROID })).rejects.toThrow(
      /excludes the android target/
    );
  });

  it("fails when the platform param is excluded, before listing any device", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry, invokeTool } = mockRegistry([iosEntry(IOS)]);

    await expect(run(registry, "ios-only", { platform: "chromium" })).rejects.toThrow(
      /excludes the chromium target/
    );
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("runs when the device satisfies the requirement", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry();

    expect((await run(registry, "ios-only", { device: IOS })).ok).toBe(true);
  });

  it("fails when the device is not the required runtime kind", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry();

    const err = await run(registry, "tv-only", { device: IOS }).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/is mobile, not tv/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
  });

  it("runs on a device of the required runtime kind", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry();

    expect((await run(registry, "tv-only", { device: IOS_TV })).ok).toBe(true);
  });

  it("refuses rather than assumes when the runtime kind cannot be read", async () => {
    // An unverifiable TV requirement waved through is the silent pass the block
    // exists to prevent.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    runtimeKinds.delete(ANDROID);
    const { registry } = mockRegistry();

    await expect(run(registry, "tv-only", { device: ANDROID })).rejects.toThrow(
      /could not be determined/
    );
  });

  it("reports an unreadable runtime kind under its own code, not the skip code", async () => {
    // A broken probe is not "this flow does not apply here": a directory run
    // skips on FLOW_REQUIREMENTS_UNMET, and a wedged adb must not read as a
    // filter.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    runtimeKinds.delete(ANDROID);
    const { registry } = mockRegistry();

    const err = await run(registry, "tv-only", { device: ANDROID }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNVERIFIABLE);
    // Still validation, so the flow fails on its own without stopping a batch.
    expect(getFailureSignal(err)?.error_kind).toBe("validation");
  });

  it("runs a remote simulator against an ios+mobile requirement", async () => {
    // `ios-remote` folds to `ios` for the platform half, so the runtime-kind
    // half has to answer too or the pair is unsatisfiable on a remote sim.
    await writeFlow("ios-mobile", { requires: { platform: ["ios"], runtimeKind: "mobile" } });
    const { registry } = mockRegistry();

    expect((await run(registry, "ios-mobile", { device: IOS_REMOTE })).ok).toBe(true);
  });

  it("launches the ios bundle on a remote simulator the requires fold admitted", async () => {
    // The requires fold admits a remote sim and the parse check certifies the
    // file via its `ios` entry, so the launch lookup must fold too: unfolded it
    // falls through to `native` and launches the wrong bundle.
    await writeFlow("ios-e2e", {
      requires: { platform: ["ios"] },
      steps: [{ kind: "launch", app: { ios: "com.acme.app", native: "com.acme.other" } }],
    });
    const { registry, invokeTool } = mockRegistry();

    const result = await run(registry, "ios-e2e", { device: IOS_REMOTE });

    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "launch", status: "pass" });
    expect(invokeTool).toHaveBeenCalledWith(
      "restart-app",
      expect.objectContaining({ bundleId: "com.acme.app" })
    );
  });

  it("refuses a mobile remote simulator on a tv requirement, naming its kind", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry();

    await expect(run(registry, "tv-only", { device: IOS_REMOTE })).rejects.toThrow(
      /is mobile, not tv/
    );
  });

  it("refuses a remote simulator the remote listing does not know", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    runtimeKinds.delete(IOS_REMOTE);
    const { registry } = mockRegistry();

    await expect(run(registry, "tv-only", { device: IOS_REMOTE })).rejects.toThrow(
      /could not be determined/
    );
  });
});

describe("requirements narrow device auto-detection", () => {
  it("picks the one booted device that matches instead of failing as ambiguous", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([iosEntry(IOS), androidEntry(ANDROID)]);

    expect((await run(registry, "ios-only")).device).toBe(IOS);
  });

  it("picks by runtime kind, read off the listing with no extra probe", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([iosEntry(IOS, "mobile"), iosEntry(IOS_TV, "tv")]);

    expect((await run(registry, "tv-only")).device).toBe(IOS_TV);
  });

  it("excludes a device whose runtime kind the listing could not report", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([iosEntry(IOS_TV, "tv"), androidEntry(ANDROID)]);

    expect((await run(registry, "tv-only")).device).toBe(IOS_TV);
  });

  it("reports requirements unmet — not a device-resolution failure — when nothing matches", async () => {
    // The distinction is load-bearing: a directory run turns this code into a
    // per-flow skip and keeps going.
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([androidEntry(ANDROID)]);

    await expect(run(registry, "ios-only")).rejects.toMatchObject({
      message: expect.stringMatching(/No booted device satisfies this flow's requires/),
    });
  });

  it("names the unreadable kind that ruled a device out, rather than listing it as eligible", async () => {
    // Without the kind the listing reads as a device that should have matched.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([androidEntry(ANDROID)]);

    await expect(run(registry, "tv-only")).rejects.toThrow(
      new RegExp(`Available devices: ${ANDROID} \\(android, device, kind unknown\\)`)
    );
  });

  it("names the actual kind when the listing could report it", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([androidEntry(ANDROID, "mobile")]);

    await expect(run(registry, "tv-only")).rejects.toThrow(
      new RegExp(`Available devices: ${ANDROID} \\(android, device, mobile\\)`)
    );
  });

  it("keeps the kind out of the ambiguity message, where it is noise", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([iosEntry(IOS, "mobile"), iosEntry(IOS_TV, "tv")]);

    await expect(run(registry, "ios-only")).rejects.toThrow(
      new RegExp(`Available devices: ${IOS} \\(ios, Booted\\), ${IOS_TV} \\(ios, Booted\\)\\.$`)
    );
  });

  it("still reports no-device when the machine has none booted at all", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([]);

    await expect(run(registry, "ios-only")).rejects.toThrow(/No booted device found/);
  });

  it("stays ambiguous when the requirement leaves more than one candidate", async () => {
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([iosEntry(IOS), iosEntry(IOS_TV)]);

    await expect(run(registry, "ios-only")).rejects.toThrow(/2 booted devices matched/);
  });

  it("narrows within an explicit platform rather than fighting it", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([
      iosEntry(IOS, "mobile"),
      iosEntry(IOS_TV, "tv"),
      androidEntry(ANDROID, "tv"),
    ]);

    expect((await run(registry, "tv-only", { platform: "ios" })).device).toBe(IOS_TV);
  });
});

describe("composed fragments", () => {
  it("error the run: step when the run device cannot satisfy them", async () => {
    // Not a skip: a fragment silently not running would leave a green report
    // for a scenario that only half happened.
    await writeFlow("android-bit", { requires: { platform: ["android"] } });
    await writeFlow("parent", { steps: [{ kind: "run", flow: "android-bit.yaml" }] });
    const { registry } = mockRegistry();

    const result = await run(registry, "parent", { device: IOS });

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      kind: "run",
      status: "error",
      reason: expect.stringMatching(/cannot run on this device/),
    });
  });

  it("run when the device satisfies them", async () => {
    await writeFlow("ios-bit", { requires: { platform: ["ios"] } });
    await writeFlow("parent", { steps: [{ kind: "run", flow: "ios-bit.yaml" }] });
    const { registry } = mockRegistry();

    expect((await run(registry, "parent", { device: IOS })).ok).toBe(true);
  });
});

describe("a flow that touches no device", () => {
  it("runs despite requirements — there is no target to judge", async () => {
    await writeFlow("narration", {
      requires: { platform: ["android"] },
      steps: [{ kind: "echo", message: "hi" }],
    });
    const { registry, invokeTool } = mockRegistry([iosEntry(IOS)]);

    const result = await run(registry, "narration");

    expect(result.ok).toBe(true);
    expect(result.device).toBe("");
    expect(invokeTool).not.toHaveBeenCalled();
  });
});

describe("a cleanup flow that only scopes a device", () => {
  // Unlike the narration flow above, this one DOES give requirements a target:
  // it needs no device to run, but the runner resolves one opportunistically so
  // the teardown stays narrowed off other agents' devices.
  const TEARDOWN: FlowStep = { kind: "tool", name: "stop-all-simulator-servers", args: {} };

  /** Every tool declares a `devices` scope — a device LIST, not a target. */
  function scopeRegistry(booted: ListedDevice[]) {
    const invokeTool = vi.fn(async (id: string) => {
      if (id === "list-devices") return { devices: booted };
      return { ok: true };
    });
    const registry = {
      invokeTool,
      getTool: vi.fn(() => ({ inputSchema: { properties: { devices: {} } } })),
    } as unknown as Registry;
    return { registry, invokeTool };
  }

  it("scopes to the device its requirements pick out of several", async () => {
    await writeFlow("ios-teardown", { requires: { platform: ["ios"] }, steps: [TEARDOWN] });
    const { registry, invokeTool } = scopeRegistry([iosEntry(IOS), androidEntry(ANDROID)]);

    const result = await run(registry, "ios-teardown");

    expect(result.ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", { devices: [IOS] });
  });

  it("reports requirements unmet rather than falling back to the machine-wide sweep", async () => {
    // The opportunistic resolve swallows one answer — "nothing booted, or
    // several" — and runs the step's unscoped meaning. An unmet requirement is
    // not that answer: an ios-only teardown reaping the android emulator that
    // happens to be the only one up is exactly what the block rules out.
    await writeFlow("ios-teardown", { requires: { platform: ["ios"] }, steps: [TEARDOWN] });
    const { registry, invokeTool } = scopeRegistry([androidEntry(ANDROID)]);

    await expect(run(registry, "ios-teardown")).rejects.toMatchObject({
      message: expect.stringMatching(/No booted device satisfies this flow's requires/),
    });
    expect(invokeTool).not.toHaveBeenCalledWith("stop-all-simulator-servers", expect.anything());
  });

  it("still sweeps unscoped when nothing is booted for the requirements to rule out", async () => {
    // An empty machine is the plain no-device case either way, and a cleanup
    // flow whose whole purpose is clearing it must still run.
    await writeFlow("ios-teardown", { requires: { platform: ["ios"] }, steps: [TEARDOWN] });
    const { registry, invokeTool } = scopeRegistry([]);

    expect((await run(registry, "ios-teardown")).ok).toBe(true);
    expect(invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {});
  });
});

describe("the chromium hoist", () => {
  it("refuses before booting when the requirements rule chromium out", async () => {
    // Parse-time validation is per-file, so a chromium launch reached through a
    // `run:` chain escapes it — and the check has to precede the boot: the
    // instance is registered for teardown only once resolveRunDevice returns, so
    // a refusal after booting would strand a live Electron process.
    await writeFlow("boot-chromium", {
      steps: [{ kind: "launch", app: { chromium: "/nonexistent/app" } }],
    });
    await writeFlow("tv-only", {
      requires: { runtimeKind: "tv" },
      steps: [{ kind: "run", flow: "boot-chromium.yaml" }],
    });
    const { registry } = mockRegistry([]);

    await expect(run(registry, "tv-only")).rejects.toThrow(/chromium is always mobile/);
  });

  it("is never reached when the platform param is already excluded", async () => {
    await writeFlow("ios-only", {
      requires: { platform: ["ios"] },
      steps: [{ kind: "launch", app: { ios: "com.a", chromium: "/nonexistent/app" } }],
    });
    const { registry } = mockRegistry([iosEntry(IOS)]);

    await expect(run(registry, "ios-only", { platform: "chromium" })).rejects.toThrow(
      /excludes the chromium target/
    );
  });
});

describe("flows without a requires block", () => {
  it("run on any device, as before", async () => {
    await writeFlow("anywhere", {});
    const { registry } = mockRegistry();

    expect((await run(registry, "anywhere", { device: ANDROID })).ok).toBe(true);
    expect((await run(registry, "anywhere", { device: CHROMIUM })).ok).toBe(true);
  });
});
