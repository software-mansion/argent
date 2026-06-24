/**
 * Regression test: `captureElementFrame` must NOT dispatch the Android describe
 * adapter for a Chromium (CDP) device. Without the chromium guard, a
 * `chromium-cdp-<port>` udid falls into `describeAndroid`, which shells
 * `adb -s chromium-cdp-<port> ...` against a serial that does not exist —
 * pointless process spawn + misleading adb error (swallowed by the outer
 * try/catch, so the only observable symptom is the wasted adb call).
 *
 * The guard short-circuits to `null` before any describe dispatch, so the test
 * asserts on the *side effect* (no adapter invoked) in addition to the null
 * result, since the null is what the catch would have returned anyway.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const describeIosMock = vi.fn();
const describeAndroidMock = vi.fn();

vi.mock("../src/tools/describe/platforms/ios", () => ({
  describeIos: (...args: unknown[]) => describeIosMock(...args),
}));
vi.mock("../src/tools/describe/platforms/android", () => ({
  describeAndroid: (...args: unknown[]) => describeAndroidMock(...args),
}));

import { captureElementFrame } from "../src/utils/match-element-frame";
import type { Registry } from "@argent/registry";

const fakeRegistry = {} as Registry;
const match = { by: "text", value: "Submit" } as const;

beforeEach(() => {
  describeIosMock.mockReset();
  describeAndroidMock.mockReset();
});

describe("captureElementFrame — chromium guard", () => {
  it("returns null for a chromium device WITHOUT dispatching any describe adapter", async () => {
    const out = await captureElementFrame(fakeRegistry, "chromium-cdp-9222", match);
    expect(out).toBeNull();
    expect(describeAndroidMock).not.toHaveBeenCalled();
    expect(describeIosMock).not.toHaveBeenCalled();
  });

  it("still dispatches the Android adapter for a genuine Android serial", async () => {
    describeAndroidMock.mockResolvedValue({ tree: null });
    // attempts: 1 — this asserts the adapter is dispatched (vs the chromium
    // guard); the warm-up retry would otherwise re-describe across the budget.
    const out = await captureElementFrame(fakeRegistry, "emulator-5554", match, { attempts: 1 });
    expect(out).toBeNull(); // null tree → no match, but the adapter WAS consulted
    expect(describeAndroidMock).toHaveBeenCalledTimes(1);
    expect(describeIosMock).not.toHaveBeenCalled();
  });
});
