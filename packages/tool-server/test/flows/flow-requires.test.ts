import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import {
  foldLeadingRequires,
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
// A probe can also REJECT (sim-remote auth, broken adb/simctl) — distinct from
// answering undefined, which means "the listing doesn't know this device".
const probeFailures = new Map<string, string>();
const probe = async (id: string) => {
  const failure = probeFailures.get(id);
  if (failure) throw new Error(failure);
  return runtimeKinds.get(id);
};
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSimulatorRuntimeKind: vi.fn(async (udid: string) => probe(udid)),
}));
vi.mock("../../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAndroidRuntimeKind: vi.fn(async (serial: string) => probe(serial)),
}));
vi.mock("../../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRemoteSimulatorRuntimeKind: vi.fn(async (udid: string) => probe(udid)),
}));

const IOS = "00000000-0000-0000-0000-0000000000ab";
const IOS_TV = "00000000-0000-0000-0000-0000000000cd";
const IOS_REMOTE = "remote:00000000-0000-0000-0000-0000000000ef";
const ANDROID = "emulator-5554";
const ANDROID_2 = "emulator-5556";
const CHROMIUM = "chromium-cdp-9222";
const VEGA = "amazon-4a27df03c9777152";

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
// Neither carries a runtimeKind: the listing never reports one for the two
// constant platforms, so a requires match has to come from the constant fold.
const vegaEntry = (serial: string): ListedDevice => ({
  platform: "vega",
  state: "running",
  serial,
});
const chromiumEntry = (id: string): ListedDevice => ({
  platform: "chromium",
  state: "Running",
  id,
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
  probeFailures.clear();
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

  it("never writes the fold-only `composed` marker into a file", () => {
    // The marker has no YAML spelling, so a file carrying it would fail to
    // re-parse. Two guards: the type split (the directive below) and
    // serialize's key-by-key projection.
    const folded = foldLeadingRequires("root", { platform: ["ios", "android"] }, [
      { flow: "frag", requires: { runtimeKind: "mobile" } },
    ]);
    expect(folded).toEqual({ platform: ["ios", "android"], runtimeKind: "mobile", composed: true });

    const yaml = serializeFlow({
      executionPrerequisite: "",
      // @ts-expect-error - a folded block is not a declarable one
      requires: folded,
      steps: [{ kind: "echo", message: "hi" }],
    });

    expect(yaml).not.toContain("composed");
    expect(parseFlow(yaml).requires).toEqual({
      platform: ["ios", "android"],
      runtimeKind: "mobile",
    });
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
    let err: unknown;
    try {
      parseFlow("requires: { platform: [chromium], runtimeKind: tv }\nsteps: []");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/can never be satisfied.*chromium never is/s);
    // Pins the code the platform+kind contradiction throws under - rethrowing
    // this branch as a plain parse error would keep the prose green.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIRES_UNSATISFIABLE);
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

  it("allows that same block once a UI guard may keep the launch unreached", () => {
    // The twin of the case above, one guard apart: a tv run that never opens the
    // banner completes end to end, so the runtime-kind-only branch reads
    // conditionality exactly as the platform branch does.
    expect(() =>
      parseFlow(
        [
          "requires: { runtimeKind: tv }",
          "steps:",
          "  - when: { visible: { id: banner } }",
          "    steps: [{ launch: { chromium: /some/app } }]",
        ].join("\n")
      )
    ).not.toThrow();
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

  it("lets a launch behind a non-platform guard miss a required platform", () => {
    // A visible: guard may never fire, so the flow still completes end to end on
    // ios - and validateRequires only rejects impossibilities.
    expect(() =>
      parseFlow(
        [
          "requires: { platform: [ios] }",
          "steps:",
          "  - when: { visible: { id: banner } }",
          "    steps: [{ launch: { android: com.a } }]",
        ].join("\n")
      )
    ).not.toThrow();
  });

  it("accepts a shared launch beside a platform-specific one behind a UI guard", () => {
    expect(() =>
      parseFlow(
        [
          "requires: { platform: [ios, android] }",
          "steps:",
          "  - launch: { native: com.shared.app }",
          "  - when: { visible: { id: onboarding-modal } }",
          "    steps: [{ launch: { ios: com.shared.app.helper } }]",
        ].join("\n")
      )
    ).not.toThrow();
  });

  it("still refuses a launch a platform guard admits but declares no id for", () => {
    // The guard admits ios, so the launch runs on every ios run - a platform
    // guard narrows the scope without making the launch conditional.
    expect(() =>
      parseFlow(
        [
          "requires: { platform: [ios, android] }",
          "steps:",
          "  - when: { platform: ios }",
          "    steps: [{ launch: { android: com.a } }]",
        ].join("\n")
      )
    ).toThrow(/declares no app id for ios/);
  });

  it("keeps a platform guard nested under a UI guard conditional", () => {
    // Conditionality is inherited: the inner platform guard is only reached when
    // the banner shows, so its launch still proves nothing about ios.
    expect(() =>
      parseFlow(
        [
          "requires: { platform: [ios] }",
          "steps:",
          "  - when: { visible: { id: banner } }",
          "    steps:",
          "      - when: { platform: ios }",
          "        steps: [{ launch: { android: com.a } }]",
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
      /excludes device "emulator-5554", whose id shape classifies it as android/
    );
  });

  it("names the literal id and the shape call when --device is not a device id", async () => {
    // A device name falls through classifyDevice's android fallback; the
    // refusal must point at the id, not read as a requires problem.
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry();

    await expect(run(registry, "ios-only", { device: "iPhone 17 Pro" })).rejects.toThrow(
      /device "iPhone 17 Pro", whose id shape classifies it as android \(no device listing is consulted - a device name is not a device id\)/
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

  it("passes an explicit vega device on a tv requirement with nothing probed", async () => {
    // No probe mock answers for VEGA: kills a probeRuntimeKind mutation whose
    // vega arm stops answering "tv" by definition (undefined refuses as
    // unverifiable, "mobile" as unmet).
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry();

    expect((await run(registry, "tv-only", { device: VEGA })).ok).toBe(true);
  });

  it("passes an explicit chromium device on a mobile requirement with nothing probed", async () => {
    // Same pin for probeRuntimeKind's chromium arm, which is always "mobile".
    await writeFlow("mobile-only", { requires: { runtimeKind: "mobile" } });
    const { registry } = mockRegistry();

    expect((await run(registry, "mobile-only", { device: CHROMIUM })).ok).toBe(true);
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

  it("carries a failed probe's own message into the unverifiable refusal", async () => {
    // A sim-remote auth failure is not "the listing doesn't know this udid":
    // the user gets the CLI's message verbatim, still under the unverifiable
    // code so a directory run fails this flow alone, not the batch.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    probeFailures.set(IOS_REMOTE, "sim-remote simctl list devices failed: not authenticated");
    const { registry } = mockRegistry();

    const err = await run(registry, "tv-only", { device: IOS_REMOTE }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNVERIFIABLE);
    expect(getFailureSignal(err)?.error_kind).toBe("validation");
    // Spell the whole block out: a refusal that under-reports what the flow
    // requires sends the author to the wrong line.
    expect((err as Error).message).toMatch(/This flow declares requires: \{ runtimeKind: tv \}/);
    expect((err as Error).message).toMatch(
      /sim-remote simctl list devices failed: not authenticated/
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

  it("refuses a lone survivor while another device's kind went unread", async () => {
    // Without the block the two booted devices report as ambiguous; the block
    // must not turn that into a silent pick over a rival it never judged.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([iosEntry(IOS_TV, "tv"), androidEntry(ANDROID)]);

    const err = await run(registry, "tv-only").catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNVERIFIABLE);
    expect((err as Error).message).toMatch(
      new RegExp(`runtime kind of ${ANDROID} could not be read`)
    );
  });

  it("picks the survivor when the rival's mismatching kind WAS read", async () => {
    // The foil to the case above, and the narrowing feature's whole point: a
    // judged exclusion leaves nothing unverified.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([
      androidEntry(ANDROID, "mobile"),
      androidEntry(ANDROID_2, "tv"),
    ]);

    expect((await run(registry, "tv-only")).device).toBe(ANDROID_2);
  });

  it("picks the survivor when a platform mismatch excluded the unread device", async () => {
    // The emulator fails the readable platform half, so its unread kind never
    // mattered — same reasoning as the skip case below, on the survivor arm.
    await writeFlow("ios-tv", { requires: { platform: ["ios"], runtimeKind: "tv" } });
    const { registry } = mockRegistry([iosEntry(IOS_TV, "tv"), androidEntry(ANDROID)]);

    expect((await run(registry, "ios-tv")).device).toBe(IOS_TV);
  });

  it("admits a listed vega device by its constant kind, with no listing field", async () => {
    // Kills a listedRuntimeKind mutation whose vega arm reads the (absent)
    // listing field instead of answering "tv" - the device would be excluded
    // as unread and the run refused.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([vegaEntry(VEGA), androidEntry(ANDROID, "mobile")]);

    expect((await run(registry, "tv-only")).device).toBe(VEGA);
  });

  it("admits a listed chromium device by its constant kind, with no listing field", async () => {
    // Same pin for listedRuntimeKind's chromium arm, which is always "mobile".
    await writeFlow("mobile-only", { requires: { runtimeKind: "mobile" } });
    const { registry } = mockRegistry([chromiumEntry(CHROMIUM), iosEntry(IOS_TV, "tv")]);

    expect((await run(registry, "mobile-only")).device).toBe(CHROMIUM);
  });

  it("reports requirements unmet — not a device-resolution failure — when nothing matches", async () => {
    // The distinction is load-bearing: a directory run turns this code into a
    // per-flow skip and keeps going.
    await writeFlow("ios-only", { requires: { platform: ["ios"] } });
    const { registry } = mockRegistry([androidEntry(ANDROID)]);

    const err = await run(registry, "ios-only").catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/No booted device satisfies this flow's requires/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
  });

  it("reports an unreadable kind as unverifiable, naming the device it never judged", async () => {
    // "Could not be read" is not "wrong kind": on the skip code a mixed
    // directory run prints PASS with this flow never executed.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([androidEntry(ANDROID)]);

    const err = await run(registry, "tv-only").catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNVERIFIABLE);
    expect((err as Error).message).toMatch(
      new RegExp(`runtime kind of ${ANDROID} could not be read`)
    );
    expect((err as Error).message).toMatch(
      new RegExp(`Available devices: ${ANDROID} \\(android, device, kind unknown\\)`)
    );
  });

  it("stays unverifiable when a readable mismatch sits next to the unread device", async () => {
    // The mobile emulator is a real exclusion, but one unanswered candidate is
    // enough to bar the skip: the flow's target may be the device nobody read.
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([androidEntry(ANDROID, "mobile"), androidEntry(ANDROID_2)]);

    const err = await run(registry, "tv-only").catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNVERIFIABLE);
    expect((err as Error).message).toMatch(
      new RegExp(`runtime kind of ${ANDROID_2} could not be read`)
    );
  });

  it("keeps the skip when a platform mismatch already excluded the unread device", async () => {
    // The emulator fails the readable platform half, so its unread kind never
    // mattered: nothing unverified stands between the flow and the skip.
    await writeFlow("ios-tv", { requires: { platform: ["ios"], runtimeKind: "tv" } });
    const { registry } = mockRegistry([androidEntry(ANDROID)]);

    const err = await run(registry, "ios-tv").catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
  });

  it("names the actual kind when the listing could report it", async () => {
    await writeFlow("tv-only", { requires: { runtimeKind: "tv" } });
    const { registry } = mockRegistry([androidEntry(ANDROID, "mobile")]);

    const err = await run(registry, "tv-only").catch((e: unknown) => e);

    expect((err as Error).message).toMatch(
      new RegExp(`Available devices: ${ANDROID} \\(android, device, mobile\\)`)
    );
    // Every exclusion was decided on a kind that WAS read, so the skip stands.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
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
    // for a scenario that only half happened. Composed after the first
    // executable step — a LEADING fragment's block folds into the run's own
    // and is refused at entry instead (see the leading-chain describe below).
    await writeFlow("android-bit", { requires: { platform: ["android"] } });
    await writeFlow("parent", {
      steps: [OK_STEP, { kind: "run", flow: "android-bit.yaml" }],
    });
    const { registry } = mockRegistry();

    const result = await run(registry, "parent", { device: IOS });

    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({
      kind: "run",
      status: "error",
      reason: expect.stringMatching(/cannot run on this device/),
    });
  });

  it("error under a prefix that does not assert a mismatch when the check is unverifiable", async () => {
    // An unreadable kind never established that the device fails the
    // requirement, so the step reason must not state "cannot run" as fact.
    await writeFlow("tv-bit", { requires: { runtimeKind: "tv" } });
    await writeFlow("parent", {
      steps: [OK_STEP, { kind: "run", flow: "tv-bit.yaml" }],
    });
    runtimeKinds.delete(ANDROID);
    const { registry } = mockRegistry();

    const result = await run(registry, "parent", { device: ANDROID });

    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({
      kind: "run",
      status: "error",
      reason: expect.stringMatching(/may not run on this device/),
    });
    expect(result.steps[1].reason).toMatch(/could not be verified/);
    expect(result.steps[1].reason).not.toMatch(/cannot run on this device/);
  });

  it("run when the device satisfies them", async () => {
    await writeFlow("ios-bit", { requires: { platform: ["ios"] } });
    await writeFlow("parent", { steps: [{ kind: "run", flow: "ios-bit.yaml" }] });
    const { registry } = mockRegistry();

    expect((await run(registry, "parent", { device: IOS })).ok).toBe(true);
  });
});

describe("requires folded along the leading run: chain", () => {
  // Every file the leading walk enters is certain to execute before step 1, so
  // its block constrains the whole run's start exactly as the root's does.

  it("narrows auto-detection with a leading fragment's block", async () => {
    // The reusable fragment is the natural home for the constraint; a root
    // that merely composes it inherits the narrowing.
    await writeFlow("android-frag", { requires: { platform: ["android"] } });
    await writeFlow("composed", { steps: [{ kind: "run", flow: "android-frag.yaml" }] });
    const { registry } = mockRegistry([iosEntry(IOS), androidEntry(ANDROID)]);

    expect((await run(registry, "composed")).device).toBe(ANDROID);
  });

  it("skips — not reds — a composing root pointed at an excluded device", async () => {
    await writeFlow("android-frag", { requires: { platform: ["android"] } });
    await writeFlow("composed", { steps: [{ kind: "run", flow: "android-frag.yaml" }] });
    const { registry } = mockRegistry([iosEntry(IOS)]);

    const err = await run(registry, "composed", { device: IOS }).catch((e: unknown) => e);

    // The skip code — not FLOW_DEVICE_RESOLUTION and not a red run: step — so
    // a directory run pointed at ios filters the flow out instead of failing.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
    // The block is nobody's single declaration, so the message says so.
    expect((err as Error).message).toMatch(/composed fragments together declare/);
  });

  it("skips on an excluded platform param too, before listing any device", async () => {
    await writeFlow("android-frag", { requires: { platform: ["android"] } });
    await writeFlow("composed", { steps: [{ kind: "run", flow: "android-frag.yaml" }] });
    const { registry, invokeTool } = mockRegistry([iosEntry(IOS)]);

    const err = await run(registry, "composed", { platform: "ios" }).catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("refuses the chromium hoist before booting when a leading fragment requires tv", async () => {
    // The tv block lives on a fragment the chain crosses, not the root — the
    // refusal must still precede the boot: the requirements error, never the
    // boot-shaped "Electron boot: path does not exist".
    await writeFlow("boot-chromium", {
      steps: [{ kind: "launch", app: { chromium: "/nonexistent/app" } }],
    });
    await writeFlow("tv-frag", {
      requires: { runtimeKind: "tv" },
      steps: [{ kind: "run", flow: "boot-chromium.yaml" }],
    });
    await writeFlow("composed", { steps: [{ kind: "run", flow: "tv-frag.yaml" }] });
    const { registry } = mockRegistry([]);

    const err = await run(registry, "composed").catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/chromium is always mobile/);
    expect((err as Error).message).not.toMatch(/Electron boot/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIREMENTS_UNMET);
  });

  it("rejects an unsatisfiable fold, naming both files", async () => {
    // A broken composition goes red once — a silent skip would hide it in
    // every directory run forever.
    await writeFlow("android-frag", { requires: { platform: ["android"] } });
    await writeFlow("composed", {
      requires: { platform: ["ios"] },
      steps: [{ kind: "run", flow: "android-frag.yaml" }],
    });
    const { registry } = mockRegistry([iosEntry(IOS), androidEntry(ANDROID)]);

    const err = await run(registry, "composed").catch((e: unknown) => e);

    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIRES_UNSATISFIABLE);
    // Validation, so a directory run fails this flow alone, not the batch.
    expect(getFailureSignal(err)?.error_kind).toBe("validation");
    expect((err as Error).message).toMatch(/"composed"/);
    expect((err as Error).message).toMatch(/"android-frag"/);
  });

  it("does not fold a fragment composed after the first executable step", async () => {
    // A mid-run block is conditional on reaching its step and is judged there
    // (the run: step check); folding it would let a fragment the run may never
    // reach veto device selection.
    await writeFlow("android-frag", { requires: { platform: ["android"] } });
    await writeFlow("root", {
      steps: [OK_STEP, { kind: "run", flow: "android-frag.yaml" }],
    });
    const { registry } = mockRegistry([iosEntry(IOS), androidEntry(ANDROID)]);

    await expect(run(registry, "root")).rejects.toThrow(/2 booted devices matched/);
  });

  it("does not fold a fragment behind a when: guard", async () => {
    await writeFlow("android-frag", { requires: { platform: ["android"] } });
    await writeFlow("root", {
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "run", flow: "android-frag.yaml" }],
        },
      ],
    });
    const { registry } = mockRegistry([iosEntry(IOS), androidEntry(ANDROID)]);

    await expect(run(registry, "root")).rejects.toThrow(/2 booted devices matched/);
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
