/**
 * Issue #618. `debugger-connect` hands back a Metro `logicalDeviceId`, and when
 * several devices share one Metro the debugger tools tell the user to pass it.
 * But `classifyDevice` decides platform purely from an id's shape, and an opaque
 * logical id matches nothing, so it falls through to "android"
 * (utils/device-info.ts:52).
 *
 * Following the tools' own advice therefore built a `NativeProfilerSession`
 * under an id no session was ever stored under. The registry mints services on
 * demand, so that resolved to a brand-new session frozen to "android" — and an
 * iOS user was told "No Android trace loaded". The wrong service, not just the
 * wrong word.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getFailureSignal } from "@argent/registry";
import {
  rememberDeviceAlias,
  forgetDeviceAlias,
  resetDeviceAliases,
} from "../../src/utils/debugger/device-alias";
import { resolveDevice } from "../../src/utils/device-info";
import { zodObjectToJsonSchema } from "@argent/registry";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";
import { nativeProfilerSessionBlueprint } from "../../src/blueprints/native-profiler-session";

const LOGICAL_ID = "8a44101d";
const IOS_UDID = "1E273101-2926-4A76-88D0-544C7EA5C2FD";

const schema = profilerCombinedReportTool.zodSchema!;

function parseDeviceId(id: string): string {
  return (schema.parse({ port: 8081, device_id: id }) as { device_id: string }).device_id;
}

beforeEach(() => {
  resetDeviceAliases();
});

describe("device_id accepts either id namespace", () => {
  it("resolves a Metro logicalDeviceId to the device it was connected with", () => {
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);

    expect(parseDeviceId(LOGICAL_ID)).toBe(IOS_UDID);
  });

  it("routes the resolved id to the iOS session, not a minted Android one", () => {
    // The reported symptom, at the layer that caused it: services() builds the
    // URN, so if canonicalization does not happen before that, the tool opens a
    // session that never existed.
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);

    const params = schema.parse({ port: 8081, device_id: LOGICAL_ID });
    const refs = profilerCombinedReportTool.services!(params as never) as {
      nativeSession: { urn: string; options: { device: { platform: string } } };
    };

    expect(refs.nativeSession.urn).toBe(`NativeProfilerSession:${IOS_UDID}`);
    expect(refs.nativeSession.options.device.platform).toBe("ios");
  });

  it("passes an id through untouched once its alias is gone", () => {
    // Aliases live only as long as the debugger connection: they are dropped on
    // dispose, so this is the ordinary state a while after profiling.
    rememberDeviceAlias(LOGICAL_ID, IOS_UDID);
    forgetDeviceAlias(LOGICAL_ID);

    expect(parseDeviceId(LOGICAL_ID)).toBe(LOGICAL_ID);
  });
});

describe("shape-based classification is left alone", () => {
  it("still treats an opaque serial as a physical Android device", () => {
    // The load-bearing fallback. A physical Android serial is an arbitrary
    // manufacturer string with no matchable shape, which is exactly why
    // classifyDevice ends in "android" — so the fix must not tighten it, and
    // must not rewrite an id that was never aliased.
    expect(parseDeviceId("HT82A0203045")).toBe("HT82A0203045");
    expect(resolveDevice("HT82A0203045")).toMatchObject({ platform: "android", kind: "device" });
  });

  it("still treats a wireless-debugging address as a physical device", () => {
    expect(resolveDevice("192.168.1.5:5555")).toMatchObject({
      platform: "android",
      kind: "device",
    });
  });

  it("still treats an emulator serial as an emulator", () => {
    expect(parseDeviceId("emulator-5554")).toBe("emulator-5554");
    expect(resolveDevice("emulator-5554")).toMatchObject({ platform: "android", kind: "emulator" });
  });

  it("leaves a Chromium id alone", () => {
    expect(parseDeviceId("chromium-cdp-19222")).toBe("chromium-cdp-19222");
  });
});

describe("the published schema", () => {
  it("does not leak the transform to callers", () => {
    // The wire contract must stay a plain string: agents read this schema, and a
    // transform in it would be neither meaningful nor representable.
    const json = zodObjectToJsonSchema(schema) as {
      properties: { device_id: Record<string, unknown> };
      required?: string[];
    };

    expect(json.properties.device_id).toMatchObject({ type: "string", minLength: 1 });
    expect(json.properties.device_id.description).toEqual(expect.any(String));
    expect(json.required).toContain("device_id");
  });

  it("rejects an empty device_id instead of resolving it to an Android device", () => {
    // classifyDevice("") is "android" too, so an empty id used to produce a
    // plausible-looking device rather than an error.
    expect(schema.safeParse({ port: 8081, device_id: "" }).success).toBe(false);
  });
});

describe("an unrecognised device is not reported as an Android device", () => {
  async function sessionWithPlatform(platform: "ios" | "android") {
    const device = { id: "whatever", platform, kind: "simulator" as const };
    const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
    return instance.api;
  }

  for (const platform of ["ios", "android"] as const) {
    it(`says nothing about the platform for a session that never captured (${platform})`, async () => {
      // A session with no capture state at all was minted by this very call, so
      // its platform is whatever the id's shape guessed — it is not evidence
      // about the device and must not be reported as if it were.
      const nativeSession = await sessionWithPlatform(platform);

      const err = await profilerCombinedReportTool.execute!(
        { nativeSession } as never,
        { port: 8081, device_id: LOGICAL_ID } as never
      )
        .then(() => null)
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/No native profiler capture is loaded/);
      expect(err!.message).not.toMatch(/android/i);
      // And it names the way out of the id mix-up that causes this.
      expect(err!.message).toMatch(/list-devices/);
      expect(getFailureSignal(err!)?.error_code).toBe("PROFILER_DATA_NOT_LOADED");
    });
  }

  it("still gives the Android-specific message once a trace proves the platform", async () => {
    // Started but not stopped: traceFile is set, so the platform IS known and
    // the specific guidance is correct. The neutral gate must not swallow it.
    const device = { id: "emulator-5554", platform: "android" as const, kind: "emulator" as const };
    const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
    const nativeSession = instance.api;
    nativeSession.traceFile = "/tmp/fake.pftrace";

    const err = await profilerCombinedReportTool.execute!(
      { nativeSession } as never,
      { port: 8081, device_id: "emulator-5554" } as never
    )
      .then(() => null)
      .catch((e: Error) => e);

    expect(err!.message).toMatch(/No Android trace loaded/);
  });
});
