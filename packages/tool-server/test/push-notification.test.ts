import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

import { FAILURE_CODES, getFailureSignal, zodObjectToJsonSchema } from "@argent/registry";
import { pushNotificationTool } from "../src/tools/push-notification";
import { createRegistry } from "../src/utils/setup-registry";

const IOS_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ANDROID_SERIAL = "emulator-5554";
const BUNDLE_ID = "com.example.app";

// FailureError attaches its FailureSignal under a non-enumerable symbol, so
// toMatchObject can't see it — assert through the public accessor instead. The
// `typeof code === "string"` guard keeps a stale @argent/registry dist (where a
// new FAILURE_CODES member resolves to undefined) from defanging the matcher.
function failsWith(code: string): (err: unknown) => boolean {
  return (err) => typeof code === "string" && getFailureSignal(err)?.error_code === code;
}

interface RecordedCall {
  args: string[];
  stdin: string;
}

const calls: RecordedCall[] = [];

// Simulates execFile: records argv, hands back a fake ChildProcess whose stdin
// captures what the handler writes, and defers the callback a microtask so the
// stdin write (which happens right after execFile returns) lands first — the
// same ordering as the real thing, where simctl exits only after stdin EOF.
function execFileBehavior(
  behavior: (args: string[]) => { error?: Error; stdout?: string } | undefined
): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      const call: RecordedCall = { args, stdin: "" };
      calls.push(call);
      const outcome = behavior(args) ?? {};
      queueMicrotask(() => {
        if (outcome.error) cb(outcome.error, "", outcome.error.message);
        else cb(null, outcome.stdout ?? "", "");
      });
      return {
        stdin: {
          on: () => {},
          write: (chunk: string) => {
            call.stdin += chunk;
          },
          end: () => {},
        },
      };
    }
  );
}

// Default: get_app_container finds the app, push succeeds.
function simctlDefaults(): void {
  execFileBehavior((args) => {
    if (args.includes("get_app_container")) return { stdout: "/containers/app" };
    return {};
  });
}

function pushCall(): RecordedCall | undefined {
  return calls.find((c) => c.args.includes("push"));
}

beforeEach(() => {
  execFileMock.mockReset();
  calls.length = 0;
  simctlDefaults();
});

describe("push-notification failure codes are defined", () => {
  it("resolves the push codes to strings", () => {
    for (const code of ["IOS_PUSH_FAILED", "IOS_PUSH_PAYLOAD_INVALID"] as const) {
      expect(typeof FAILURE_CODES[code], code).toBe("string");
    }
  });
});

describe("push-notification registration", () => {
  // Regression guard for the "implemented but never registered" class of bug
  // (see the unregistered `paste` tool): resolve the tool through the real
  // registry, not by importing the definition directly.
  it("is registered in createRegistry()", () => {
    expect(createRegistry().getTool("push-notification")).toBeDefined();
  });

  it("derives a JSON schema without throwing", () => {
    const schema = zodObjectToJsonSchema(pushNotificationTool.zodSchema!);
    expect(schema.properties).toHaveProperty("payload");
    expect(schema.properties).toHaveProperty("title");
  });
});

describe("push-notification delivery", () => {
  it("builds an APNS envelope from title/body and streams it to simctl stdin", async () => {
    const result = await pushNotificationTool.execute!(
      {},
      { udid: IOS_UDID, bundleId: BUNDLE_ID, title: "Hi", body: "There" }
    );
    const push = pushCall();
    expect(push?.args).toEqual(["simctl", "push", IOS_UDID, BUNDLE_ID, "-"]);
    expect(JSON.parse(push!.stdin)).toEqual({ aps: { alert: { title: "Hi", body: "There" } } });
    expect(result).toEqual({
      delivered: true,
      bundleId: BUNDLE_ID,
      payloadBytes: Buffer.byteLength(push!.stdin, "utf8"),
    });
  });

  it("includes subtitle, badge 0, and sound in the envelope", async () => {
    await pushNotificationTool.execute!(
      {},
      {
        udid: IOS_UDID,
        bundleId: BUNDLE_ID,
        title: "T",
        subtitle: "S",
        body: "B",
        badge: 0,
        sound: "default",
      }
    );
    expect(JSON.parse(pushCall()!.stdin)).toEqual({
      aps: { alert: { title: "T", subtitle: "S", body: "B" }, badge: 0, sound: "default" },
    });
  });

  it("delivers a raw payload verbatim, custom keys included", async () => {
    const payload = { aps: { "content-available": 1 }, customKey: { deep: true } };
    await pushNotificationTool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, payload });
    expect(JSON.parse(pushCall()!.stdin)).toEqual(payload);
  });

  it("probes get_app_container before pushing", async () => {
    await pushNotificationTool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, title: "Hi" });
    expect(calls[0]!.args).toEqual(["simctl", "get_app_container", IOS_UDID, BUNDLE_ID]);
    expect(calls[1]!.args).toContain("push");
  });
});

describe("push-notification validation", () => {
  it("rejects payload combined with convenience fields", async () => {
    await expect(
      pushNotificationTool.execute!(
        {},
        { udid: IOS_UDID, bundleId: BUNDLE_ID, payload: { aps: {} }, title: "Hi" }
      )
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.IOS_PUSH_PAYLOAD_INVALID));
    expect(calls).toHaveLength(0);
  });

  it("rejects a call with neither payload nor title/body", async () => {
    await expect(
      pushNotificationTool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, badge: 3 })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.IOS_PUSH_PAYLOAD_INVALID));
    expect(calls).toHaveLength(0);
  });

  it("rejects a raw payload without an aps key", async () => {
    await expect(
      pushNotificationTool.execute!(
        {},
        { udid: IOS_UDID, bundleId: BUNDLE_ID, payload: { alert: "hi" } }
      )
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.IOS_PUSH_PAYLOAD_INVALID));
    expect(calls).toHaveLength(0);
  });

  it("rejects payloads over 4096 bytes with the byte count in the message", async () => {
    const payload = { aps: { alert: "x".repeat(5000) } };
    await expect(
      pushNotificationTool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, payload })
    ).rejects.toMatchObject({ message: expect.stringContaining("4096") });
    expect(calls).toHaveLength(0);
  });

  it("rejects an Android serial via the capability gate", async () => {
    await expect(
      pushNotificationTool.execute!({}, { udid: ANDROID_SERIAL, bundleId: BUNDLE_ID, title: "Hi" })
    ).rejects.toMatchObject({ message: expect.stringMatching(/not supported on android/i) });
    expect(calls).toHaveLength(0);
  });
});

describe("push-notification error mapping", () => {
  it("maps a definitively-missing app to a friendly not-installed error", async () => {
    execFileBehavior((args) => {
      if (args.includes("get_app_container")) {
        return { error: Object.assign(new Error("No such file or directory"), { code: 2 }) };
      }
      return {};
    });
    await expect(
      pushNotificationTool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, title: "Hi" })
    ).rejects.toMatchObject({ message: expect.stringContaining("not installed") });
    expect(pushCall()).toBeUndefined();
  });

  it("falls through to the push when the install probe is inconclusive", async () => {
    execFileBehavior((args) => {
      if (args.includes("get_app_container")) {
        return {
          error: Object.assign(new Error("Unable to lookup in current state: Shutdown"), {
            code: 1,
          }),
        };
      }
      return {};
    });
    const result = await pushNotificationTool.execute!(
      {},
      { udid: IOS_UDID, bundleId: BUNDLE_ID, title: "Hi" }
    );
    expect(result.delivered).toBe(true);
    expect(pushCall()).toBeDefined();
  });

  it("adds the boot-device hint when the simulator is shut down", async () => {
    execFileBehavior((args) => {
      if (args.includes("push")) {
        return {
          error: Object.assign(new Error("Unable to lookup in current state: Shutdown"), {
            code: 1,
          }),
        };
      }
      return { stdout: "/containers/app" };
    });
    await expect(
      pushNotificationTool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, title: "Hi" })
    ).rejects.toSatisfy(
      (err: unknown) =>
        failsWith(FAILURE_CODES.IOS_PUSH_FAILED)(err) &&
        err instanceof Error &&
        err.message.includes("boot-device")
    );
  });

  it("wraps other simctl failures with the push failure code", async () => {
    execFileBehavior((args) => {
      if (args.includes("push")) {
        return { error: Object.assign(new Error("Invalid device: gone"), { code: 164 }) };
      }
      return { stdout: "/containers/app" };
    });
    await expect(
      pushNotificationTool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, title: "Hi" })
    ).rejects.toSatisfy(failsWith(FAILURE_CODES.IOS_PUSH_FAILED));
  });
});
