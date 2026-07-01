import { describe, it, expect, afterEach } from "vitest";
import { FAILURE_CODES, getFailureSignal, type FailureCode } from "@argent/registry";

import {
  setActiveProjectRoot,
  clearActiveProjectRoot,
  assertSafeFlowName,
  getFlowPath,
} from "../src/tools/flows/flow-utils";
import { keyboardTool } from "../src/tools/keyboard/index";
import { chromiumCdpBlueprint } from "../src/blueprints/chromium-cdp";

/**
 * Telemetry only reads a FailureError's signal when it propagates out of a tool's
 * `execute` (the registry's `toolFailed` event walks the cause chain via
 * `getFailureSignal`). These tests pin the `error_code` of representative
 * newly-classified throw sites — across the flows, keyboard, and chromium areas —
 * so a regression that drops or mis-codes a classification is caught in CI rather
 * than only in a one-off manual run.
 */

/** Await a promise expected to reject and return the thrown error. */
async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw, but it resolved");
}

/** Run a synchronous function expected to throw and return the thrown error. */
function captureSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw, but it returned");
}

function expectCode(err: unknown, code: FailureCode): void {
  expect(getFailureSignal(err)?.error_code).toBe(code);
}

afterEach(() => {
  // setActiveProjectRoot mutates module state; reset so cases don't leak.
  clearActiveProjectRoot();
});

describe("flow-utils classifications", () => {
  it("classifies a relative project_root as FLOW_PROJECT_ROOT_INVALID", () => {
    expectCode(
      captureSync(() => setActiveProjectRoot("relative/path")),
      FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID
    );
  });

  it("classifies a project_root containing '..' as FLOW_PROJECT_ROOT_INVALID", () => {
    expectCode(
      captureSync(() => setActiveProjectRoot("/a/../b")),
      FAILURE_CODES.FLOW_PROJECT_ROOT_INVALID
    );
  });

  it("classifies path resolution with no active project_root as FLOW_PROJECT_ROOT_REQUIRED", () => {
    // No active root → getFlowPath → getFlowsDir → requireActiveProjectRoot throws.
    expectCode(
      captureSync(() => getFlowPath("valid-name")),
      FAILURE_CODES.FLOW_PROJECT_ROOT_REQUIRED
    );
  });

  it("classifies an unsafe flow name as FLOW_NAME_INVALID", () => {
    expectCode(
      captureSync(() => assertSafeFlowName("bad name!")),
      FAILURE_CODES.FLOW_NAME_INVALID
    );
  });
});

describe("keyboard classifications", () => {
  // The chromium handler validates the key/char before touching the CDP api, so a
  // bare stub is enough to reach the throw.
  const chromiumServices = { chromium: {} as never };
  const udid = "chromium-cdp-9222";

  it("classifies an unknown named key as KEYBOARD_KEY_UNSUPPORTED", async () => {
    expectCode(
      await captureError(keyboardTool.execute(chromiumServices, { udid, key: "not-a-key" })),
      FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED
    );
  });

  it("classifies an unmappable character as KEYBOARD_CHARACTER_UNSUPPORTED", async () => {
    expectCode(
      await captureError(keyboardTool.execute(chromiumServices, { udid, text: "\u{1F600}" })),
      FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED
    );
  });
});

describe("chromium blueprint factory classifications", () => {
  const device = (id: string) => ({ id, platform: "chromium" as const, kind: "app" as const });

  it("classifies a malformed chromium device id as CHROMIUM_DEVICE_ID_INVALID", async () => {
    // A well-formed id that agrees between options and URN passes the (uncoded)
    // wiring guards, then the port parse fails — exercising the reachable
    // CHROMIUM_DEVICE_ID_INVALID branch.
    expectCode(
      await captureError(
        chromiumCdpBlueprint.factory({}, device("chromium-cdp-bogus"), {
          device: device("chromium-cdp-bogus"),
        })
      ),
      FAILURE_CODES.CHROMIUM_DEVICE_ID_INVALID
    );
  });
});
