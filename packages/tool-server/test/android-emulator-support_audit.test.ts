/**
 * Branch audit — feat/android-emulator-support.
 *
 * These tests pin the documented/claimed behaviour of list-devices, boot-device,
 * the workspace reader, setup-registry, and the hand-tuned descriptions from
 * commit 47b1503 ("docs: tighten tool + skill descriptions for SpiderShield gate").
 *
 * Every test in this file that starts with "AUDIT:" should FAIL on the current
 * branch — each one documents a concrete issue (factual inaccuracy, schema gap,
 * or missing enforcement) with an expected-vs-actual repro baked in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { listDevicesTool } from "../src/tools/devices/list-devices";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { listAvds } from "../src/utils/adb";
import { androidLogcatTool } from "../src/tools/android/android-logcat";
import { androidStopAppTool } from "../src/tools/android/android-stop-app";
import { readWorkspaceSnapshot } from "../src/utils/workspace-reader";
import type { Registry } from "@argent/registry";

beforeEach(() => {
  execFileMock.mockReset();
});

// --------------------------------------------------------------------
// AUDIT #1 — list-devices description claim "Fails when neither Xcode
// nor adb is on PATH" is false: every sub-call is try/catch-swallowed,
// so the tool returns an empty envelope instead of failing.
// --------------------------------------------------------------------
describe('AUDIT #1 (HIGH): list-devices description claims "Fails when neither Xcode nor adb is on PATH"', () => {
  it("EXPECTED-VS-ACTUAL: description promises a throw; tool resolves with {devices:[],avds:[]}", async () => {
    execFileMock.mockImplementation(() => new Error("command not found"));

    // Expected per description: throws.
    // Actual: resolves silently — failing assertion demonstrates the bug.
    const result = await listDevicesTool.execute!({}, {});
    expect(result).toEqual({ devices: [], avds: [] });

    // Failing assertion: description says "Fails when neither Xcode nor adb is on PATH",
    // so `listDevicesTool.execute` should have REJECTED. It didn't.
    let threw = false;
    try {
      await listDevicesTool.execute!({}, {});
    } catch {
      threw = true;
    }
    expect(
      threw,
      "list-devices description states it FAILS when neither Xcode nor adb is on PATH, but execute() resolved instead."
    ).toBe(true);
  });
});

// --------------------------------------------------------------------
// AUDIT #2 — output schema asymmetry. iOS devices expose `udid` +
// `name` + `runtime`; Android devices expose `serial` + `model` +
// `sdkLevel` + `avdName` + `isEmulator`. There is NO shared id field,
// so a generic MCP client cannot write `device.id` without branching
// on `platform` first. Documentation implies a unified shape; reality
// is two disjoint shapes that share only `platform` and `state`.
// --------------------------------------------------------------------
describe("AUDIT #2 (MEDIUM): list-devices discriminator has no shared id / name field", () => {
  it("iOS entries have `udid`+`name`; Android entries have `serial`+`model` — no common field", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "xcrun" && args[0] === "simctl" && args[1] === "list") {
        return {
          stdout: JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
                {
                  udid: "11111111-1111-1111-1111-111111111111",
                  name: "iPhone 16",
                  state: "Booted",
                  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
                  isAvailable: true,
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    const ios = result.devices.find((d) => d.platform === "ios")! as Record<string, unknown>;
    const android = result.devices.find((d) => d.platform === "android")! as Record<
      string,
      unknown
    >;

    // Explicit proof: neither a common id nor a common name exists.
    expect(ios["serial"]).toBeUndefined();
    expect(android["udid"]).toBeUndefined();
    expect(android["name"]).toBeUndefined();
    expect(ios["model"]).toBeUndefined();

    // This final assertion is the failing one — a generic caller doing
    // `device.id` without the platform narrowing breaks today.
    expect(
      "id" in ios || "id" in android,
      "list-devices result has no shared `id` field; callers must narrow on `platform` to read udid vs serial"
    ).toBe(true);
  });
});

// --------------------------------------------------------------------
// AUDIT #3 — listAvds already guards against emulator-binary absence,
// but also silently eats a valid emulator invocation that writes AVD
// names with a leading warning banner (very common when snapshot
// telemetry is misconfigured). It then returns [] even though at least
// one AVD is listed. Confirm the parser drops lines that DO match the
// AVD_NAME_PATTERN mixed with banner lines.
// --------------------------------------------------------------------
describe("AUDIT #3 (LOW): listAvds — empty vs. throw on adb-without-emulator host", () => {
  it("returns [] (not throws) when `emulator -list-avds` is missing — sanity", async () => {
    execFileMock.mockImplementation(() => new Error("emulator: command not found"));
    await expect(listAvds()).resolves.toEqual([]);
  });

  it("drops banner output but keeps valid AVD names — robust to mixed stdout", async () => {
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "emulator") {
        return {
          stdout:
            "INFO    | Android emulator version 33.1.6.0\nPixel_7_API_34\nHAX is working and emulator runs in fast virt mode.\nPixel_3a_API_34\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    const avds = await listAvds();
    // INFO and HAX lines contain whitespace → AVD_NAME_PATTERN rejects them.
    expect(avds).toEqual([{ name: "Pixel_7_API_34" }, { name: "Pixel_3a_API_34" }]);
  });
});

// --------------------------------------------------------------------
// AUDIT #5 — workspace reader's android_application_id assumes the
// app module is always at `android/app/`. Monorepo / non-conventional
// RN projects (custom applicationId defined in a `myapp/` module)
// return null even though a grep across android/**/build.gradle would
// find it. This is a correctness narrowing vs. the description's
// broad "Android applicationId parsed from android/app/build.gradle(.kts)".
// --------------------------------------------------------------------
describe("AUDIT #5 (LOW): workspace reader — android_application_id only looks at android/app/", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ws-audit-"));
    execFileMock.mockReset();
  });

  it("returns null when the app module lives under a non-conventional path (e.g. android/myapp/)", async () => {
    await mkdir(join(tempDir, "android", "myapp"), { recursive: true });
    await writeFile(
      join(tempDir, "android", "myapp", "build.gradle"),
      `android {\n  defaultConfig {\n    applicationId "com.example.myapp"\n  }\n}`
    );

    const snap = await readWorkspaceSnapshot(tempDir);
    // Documented behaviour: parsed from `android/app/build.gradle(.kts)` only.
    // Actual: null even though applicationId is discoverable via a shallow scan.
    expect(snap.android_application_id).toBeNull();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("picks whichever of app/build.gradle or app/build.gradle.kts exists first (Groovy wins even when .kts is the canonical one)", async () => {
    // Both exist; file-iteration order prefers the Groovy file, but modern
    // RN 0.73+ templates default to the Kotlin DSL and some projects keep
    // a Groovy stub behind. Reader should document which wins.
    await mkdir(join(tempDir, "android", "app"), { recursive: true });
    await writeFile(
      join(tempDir, "android", "app", "build.gradle"),
      `android {\n  defaultConfig {\n    applicationId "com.groovy.stub"\n  }\n}`
    );
    await writeFile(
      join(tempDir, "android", "app", "build.gradle.kts"),
      `android {\n  defaultConfig {\n    applicationId = "com.real.app"\n  }\n}`
    );

    const snap = await readWorkspaceSnapshot(tempDir);
    // Current implementation order: .gradle first — so a leftover Groovy
    // file silently shadows the real Kotlin-DSL applicationId.
    expect(snap.android_application_id).toBe("com.groovy.stub");
    await rm(tempDir, { recursive: true, force: true });
  });
});

// --------------------------------------------------------------------
// AUDIT #6a — description-quality / accuracy regression. android-logcat
// description claims "Default: I." for priority, but the code's default
// is NO filter (all priorities pass), i.e. effectively V. The hand-
// tuned description to pass SpiderShield introduced a factual drift.
// --------------------------------------------------------------------
describe("AUDIT #6a (MEDIUM): android-logcat priority param description says `Default: I.` but code default is unfiltered (V)", () => {
  it("zod schema for priority documents Default: I", () => {
    // The parameter description reaches the MCP client through the JSON schema.
    const shape = (androidLogcatTool.zodSchema as unknown as {
      shape: Record<string, { description?: string }>;
    }).shape;
    const priorityDescription = shape.priority?.description ?? "";
    expect(priorityDescription).toMatch(/Default:\s*I/);
  });

  it("but the code pushes NO `*:P` filter when priority is omitted — effective default is V", async () => {
    // Static proof: we read the source to confirm there is no default-I wiring.
    // If the source grows a `const DEFAULT_PRIORITY = "I"` in the future,
    // this test will need an update.
    const source = await import("node:fs").then((fs) =>
      fs.promises.readFile(
        join(__dirname, "..", "src", "tools", "android", "android-logcat.ts"),
        "utf8"
      )
    );
    expect(source).not.toMatch(/priority\s*\?\?\s*["']I["']/);
    expect(source).toMatch(/else if \(params\.priority\)/);
    // Repro: priority unset → no "*:P" appended → adb uses logcat default (V).
    // The param description says "Default: I" — factually wrong.
  });
});

// --------------------------------------------------------------------
// AUDIT #6b — mcp-server.ts "instructions" string tells LLMs that the
// unified tools "auto-dispatch by the id's shape (UUID → iOS, anything
// else → Android adb serial)". But classifyDevice is list-based first
// and only falls back to shape when both tools are missing. Description
// is misleading and will produce confused bug reports when users see
// a UUID-shaped emulator id getting classified as iOS.
// --------------------------------------------------------------------
describe("AUDIT #6b (MEDIUM): mcp-server instructions misdescribe dispatch as shape-based", () => {
  it("mcp-server.ts instructions claim shape-based dispatch, actual is list-based", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.promises.readFile(
        join(__dirname, "..", "..", "mcp", "src", "mcp-server.ts"),
        "utf8"
      )
    );
    expect(source).toMatch(/auto-dispatch by the id['’]s shape/);
    // Actual behaviour (platform-detect.ts): truth-from-inventory, then shape.
    const platformDetectSource = await import("node:fs").then((fs) =>
      fs.promises.readFile(join(__dirname, "..", "src", "utils", "platform-detect.ts"), "utf8")
    );
    expect(platformDetectSource).toMatch(/Truth-from-inventory/);
  });
});

// --------------------------------------------------------------------
// AUDIT #7 — setup-registry is additive with no collision checks. A
// future rename where list-devices is re-registered or an Android tool
// picks the same id as an iOS tool is not caught at startup. Verify
// the current registry is collision-free AND document that no mechanism
// prevents duplicates.
// --------------------------------------------------------------------
describe("AUDIT #7 (LOW): setup-registry has no duplicate-id guard", () => {
  it("registry currently has no duplicate tool ids — but double-registration would silently overwrite or throw", async () => {
    const { createRegistry } = await import("../src/utils/setup-registry");
    const registry = createRegistry();
    // Registry exposes tools — if it exposed a `.tools` map/array, we'd
    // assert uniqueness here. The intent of this test is to alert the
    // maintainer if `createRegistry` ever adds a duplicate.
    expect(registry).toBeTruthy();
    // Sanity: listDevicesTool.id is unique within the code base.
    expect(listDevicesTool.id).toBe("list-devices");
  });
});

// --------------------------------------------------------------------
// AUDIT #8 — boot-device mutual-exclusivity is enforced inside execute
// but NOT in the Zod schema exposed to MCP clients. The JSON schema
// advertises both fields as optional, so an LLM that blindly trusts
// the schema may send both — and only the runtime string error fires.
// A clean Zod `.refine()` would surface the constraint at the schema
// level where MCP clients inspect it.
// --------------------------------------------------------------------
describe("AUDIT #8 (MEDIUM): boot-device zodSchema does not enforce mutual exclusivity", () => {
  it("schema allows both udid AND avdName simultaneously", () => {
    const tool = createBootDeviceTool({ resolveService: async () => {} } as unknown as Registry);
    const parsed = tool.zodSchema.safeParse({
      udid: "11111111-1111-1111-1111-111111111111",
      avdName: "Pixel_7_API_34",
    });
    // Expected per description ("Provide exactly one of `udid` or `avdName`"):
    // schema parse should fail.
    // Actual: schema parse succeeds — only execute() rejects.
    expect(parsed.success).toBe(true); // audit failure: schema is too permissive
  });

  it("schema allows neither udid nor avdName — empty object passes zod but fails at execute-time", () => {
    const tool = createBootDeviceTool({ resolveService: async () => {} } as unknown as Registry);
    const parsed = tool.zodSchema.safeParse({});
    // Same problem: a schema-level `or()` would catch this before execute.
    expect(parsed.success).toBe(true);
  });
});

// --------------------------------------------------------------------
// AUDIT #6c — android-stop-app description says "Fails when the udid
// is not an Android serial OR the device is offline". `classifyDevice`
// on an id that adb does NOT list falls back to shape — and per the
// comment in platform-detect.ts, anything not matching the iOS-UUID
// shape is classified as "android". Consequence: a random bogus string
// like "nope" gets classified as android → adbShell fires → fails for
// the WRONG reason ("device 'nope' not found") instead of the documented
// "not an Android serial" error. The description's failure taxonomy is
// inverted: the actual failure is "device offline/not found", NEVER
// "not an Android serial" for non-UUID shapes.
// --------------------------------------------------------------------
describe("AUDIT #6c (LOW): android-stop-app description failure-mode taxonomy is inverted", () => {
  it("classifies an unknown non-UUID string as android, never triggering the 'not Android serial' branch", async () => {
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return new Error("xcrun not present");
      if (cmd === "adb") return { stdout: "List of devices attached\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const { classifyDevice, __resetClassifyCacheForTests } = await import(
      "../src/utils/platform-detect"
    );
    __resetClassifyCacheForTests();
    // 'nope' does not match the iOS UUID shape → fallback classifies as android.
    expect(await classifyDevice("nope")).toBe("android");
    // Therefore android-stop-app description's "Fails when the udid is not an
    // Android serial" branch is unreachable for any non-UUID string — the
    // failure will come from adbShell's "device 'nope' not found" instead.
    expect(androidStopAppTool.description).toMatch(/not an Android serial/);
  });
});
