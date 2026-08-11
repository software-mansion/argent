import { describe, it, expect, vi, beforeEach } from "vitest";

// The flow runner refuses any device whose runtime kind it cannot read, so this
// probe is the whole reason a remote simulator can satisfy a `requires.runtimeKind`.
let listing: unknown = { devices: {} };
let unreachable = false;
let calls = 0;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      _cmd: string,
      _args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      calls++;
      if (unreachable)
        return callback(new Error("sim-remote: no orchestrator"), {
          stdout: "",
          stderr: "",
        });
      callback(null, { stdout: JSON.stringify(listing), stderr: "" });
    },
  };
});

import {
  getRemoteSimulatorRuntimeKind,
  __resetRemoteSimulatorRuntimeKindCacheForTesting,
} from "../src/utils/sim-remote";

const UDID = "4A5B6C7D-1111-2222-3333-444455556666";
const IOS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const TVOS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.tvOS-18-0";

const sim = (udid: string, extra: Record<string, unknown> = {}) => ({
  udid,
  name: "A Sim",
  state: "Booted",
  ...extra,
});
const under = (runtime: string, ...devices: object[]) => ({ devices: { [runtime]: devices } });

beforeEach(() => {
  __resetRemoteSimulatorRuntimeKindCacheForTesting();
  calls = 0;
  unreachable = false;
  listing = under(IOS_RUNTIME, sim(UDID));
});

describe("getRemoteSimulatorRuntimeKind", () => {
  it("reads mobile off the iOS runtime the simulator is listed under", async () => {
    expect(await getRemoteSimulatorRuntimeKind(UDID)).toBe("mobile");
  });

  it("reads tv off a tvOS runtime", async () => {
    listing = under(TVOS_RUNTIME, sim(UDID));
    expect(await getRemoteSimulatorRuntimeKind(UDID)).toBe("tv");
  });

  it("reads the kind off the runtime holding the udid, not the first one listed", async () => {
    listing = {
      devices: {
        [IOS_RUNTIME]: [sim("11111111-0000-0000-0000-000000000000")],
        [TVOS_RUNTIME]: [sim(UDID)],
      },
    };
    expect(await getRemoteSimulatorRuntimeKind(UDID)).toBe("tv");
  });

  it("accepts the remote-prefixed id its callers actually hold", async () => {
    expect(await getRemoteSimulatorRuntimeKind(`remote:${UDID}`)).toBe("mobile");
  });

  it("memoizes across both spellings, so a repeat check costs no round-trip", async () => {
    await getRemoteSimulatorRuntimeKind(`remote:${UDID}`);
    await getRemoteSimulatorRuntimeKind(UDID);
    expect(calls).toBe(1);
  });

  it("re-probes after an unknown udid rather than caching the miss", async () => {
    // The sim may simply not have been created yet when the first call landed.
    listing = under(IOS_RUNTIME, sim("11111111-0000-0000-0000-000000000000"));
    expect(await getRemoteSimulatorRuntimeKind(UDID)).toBeUndefined();
    listing = under(IOS_RUNTIME, sim(UDID));
    expect(await getRemoteSimulatorRuntimeKind(UDID)).toBe("mobile");
  });

  it("does not answer for a simulator the listing marks unavailable", async () => {
    listing = under(IOS_RUNTIME, sim(UDID, { isAvailable: false }));
    expect(await getRemoteSimulatorRuntimeKind(UDID)).toBeUndefined();
  });

  it("propagates a sim-remote failure verbatim instead of answering undefined", async () => {
    // Undefined means "the listing doesn't know this udid" and its caller turns
    // it into a bare refusal; an unreachable sim-remote must instead surface the
    // CLI's own message, per the module's error contract.
    unreachable = true;
    await expect(getRemoteSimulatorRuntimeKind(UDID)).rejects.toThrow(
      /sim-remote simctl list devices --json failed: sim-remote: no orchestrator/
    );
  });

  it("skips a runtime entry that is not a device array rather than throwing", async () => {
    listing = { devices: { [IOS_RUNTIME]: "nope", [TVOS_RUNTIME]: [sim(UDID)] } };
    expect(await getRemoteSimulatorRuntimeKind(UDID)).toBe("tv");
  });

  it("wraps a JSON payload that is not a listing in a descriptive error", async () => {
    // An orchestrator that answers `{"error":...}` at exit 0 parses fine, and
    // must not reach the caller as a raw TypeError.
    listing = { error: "not authorized" };
    await expect(getRemoteSimulatorRuntimeKind(UDID)).rejects.toThrow(
      /sim-remote simctl list devices --json returned JSON without a devices map/
    );
  });
});
