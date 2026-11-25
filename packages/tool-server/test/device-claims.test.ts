import { describe, it, expect } from "vitest";
import {
  DeviceClaims,
  claimPickedDevice,
  claimTargets,
  deviceClaims,
  parseSession,
} from "../src/utils/device-claims";

const SIM = "11111111-2222-3333-4444-555555555555";
const EMU = "emulator-5554";

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

describe("DeviceClaims", () => {
  it("lets the claiming session call again and refuses another session", () => {
    const claims = new DeviceClaims(1_000);
    const first = claims.claim("a", [SIM]);
    expect(first.ok).toBe(true);
    if (first.ok) first.done();

    const again = claims.claim("a", [SIM]);
    expect(again.ok).toBe(true);
    expect(claims.claim("b", [SIM])).toEqual({ ok: false, device: SIM });
    expect(claims.ownerOf(SIM, "a")).toBe("this session");
    expect(claims.ownerOf(SIM, "b")).toBe("another session");
    expect(claims.ownerOf(SIM, undefined)).toBe("another session");
  });

  it("claims nothing when one of several devices is held by another session", () => {
    const claims = new DeviceClaims(1_000);
    claims.claim("a", [SIM]);
    expect(claims.claim("b", [EMU, SIM])).toEqual({ ok: false, device: SIM });
    expect(claims.ownerOf(EMU, "b")).toBeUndefined();
  });

  it("frees an idle claim after the timeout, but never during a call", () => {
    const time = clock();
    const claims = new DeviceClaims(1_000, time.now);
    const call = claims.claim("a", [SIM]);
    time.advance(5_000);
    expect(claims.claim("b", [SIM]).ok).toBe(false);

    if (call.ok) call.done();
    time.advance(1_000);
    expect(claims.claim("b", [SIM]).ok).toBe(false);
    time.advance(1);
    expect(claims.claim("b", [SIM]).ok).toBe(true);
  });

  it("releases one device or all of a session, idempotently, and never another session's", () => {
    const claims = new DeviceClaims(1_000);
    claims.claim("a", [SIM, EMU]);
    expect(claims.release("b")).toEqual([]);
    expect(claims.release("a", SIM)).toEqual([SIM]);
    expect(claims.release("a", SIM)).toEqual([]);
    expect(claims.ownerOf(EMU, "a")).toBe("this session");
    expect(claims.release("a")).toEqual([EMU]);
    expect(claims.release("a")).toEqual([]);
    expect(claims.claim("b", [SIM, EMU]).ok).toBe(true);
  });

  it("keeps a claim when a call ends after its device was released and claimed again", () => {
    const claims = new DeviceClaims(1_000);
    const stale = claims.claim("a", [SIM]);
    claims.release("a");
    const fresh = claims.claim("a", [SIM]);
    if (stale.ok) stale.done();
    expect(claims.claim("b", [SIM]).ok).toBe(false);
    if (fresh.ok) fresh.done();
  });
});

describe("claimTargets", () => {
  it("reads every device spelling once and maps an ext: id to its native id", () => {
    expect(claimTargets({ udid: SIM })).toEqual([SIM]);
    expect(claimTargets({ device_id: EMU })).toEqual([EMU]);
    expect(claimTargets({ device: EMU, project_root: "/p" })).toEqual([EMU]);
    expect(claimTargets({ devices: [SIM, EMU, SIM] })).toEqual([SIM, EMU]);
    expect(claimTargets({ udid: `ext:acme-1:${SIM}` })).toEqual([SIM]);
    expect(claimTargets({})).toEqual([]);
    expect(claimTargets(undefined)).toEqual([]);
  });
});

describe("claimPickedDevice", () => {
  it("claims a device a tool picked, refuses another session's, and skips a caller without one", () => {
    const done = claimPickedDevice("a", SIM);
    try {
      expect(() => claimPickedDevice("b", SIM)).toThrow(/in use by another Argent session/);
      expect(() => claimPickedDevice(undefined, SIM)()).not.toThrow();
    } finally {
      done();
      deviceClaims.release("a");
    }
  });
});

describe("parseSession", () => {
  it("accepts a printable id and refuses an empty, spaced or long one", () => {
    expect(parseSession(undefined)).toBeUndefined();
    expect(parseSession(" ci-job-42 ")).toBe("ci-job-42");
    expect(parseSession("")).toBeNull();
    expect(parseSession("two words")).toBeNull();
    expect(parseSession("x".repeat(129))).toBeNull();
  });
});
