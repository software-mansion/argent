import { beforeEach, describe, expect, it, vi } from "vitest";

// The "frame" the mocked screenshot pipeline returns for each capture. An
// identical frame before and after models a dropped touch; "THROW" models a
// capture that fails outright.
const frameQueue: Array<string | "THROW"> = [];
// Whether the recording pointer overlay is on (frame-diff verification stands
// down while it is).
let pointerOn = false;
// Verification frames are deleted after hashing — record the unlinks.
const unlinked: string[] = [];

vi.mock("../../src/utils/simulator-client", () => ({
  httpScreenshot: async () => {
    const token = frameQueue.shift();
    if (token === undefined || token === "THROW") throw new Error("no image to export");
    // The path carries the frame's identity; the mocked readFile turns it back
    // into bytes, so identical frames hash identically.
    return { url: `file://${token}`, path: token };
  },
  isPointerVisible: () => pointerOn,
  onAttachClose: () => {},
}));

vi.mock("node:fs/promises", () => ({
  readFile: async (p: string) => Buffer.from(String(p)),
  unlink: async (p: string) => {
    unlinked.push(p);
  },
}));

// No real settle delay in tests.
vi.mock("../../src/utils/timing", () => ({ sleep: async () => {} }));

import {
  classifyDelivery,
  deliveryWarning,
  hashFrame,
  resetDeliveryTracking,
  runWithDeliveryVerification,
  shouldAutoVerify,
  verifyTouchDelivery,
} from "../../src/utils/touch-verification";
import type { SimulatorServerApi } from "../../src/blueprints/simulator-server";

const apiA = { apiUrl: "http://127.0.0.1:1111" } as SimulatorServerApi;
const apiB = { apiUrl: "http://127.0.0.1:2222" } as SimulatorServerApi;

beforeEach(() => {
  frameQueue.length = 0;
  unlinked.length = 0;
  pointerOn = false;
  resetDeliveryTracking();
});

describe("hashFrame", () => {
  it("is deterministic and distinguishes different frames", () => {
    expect(hashFrame(Buffer.from("A"))).toBe(hashFrame(Buffer.from("A")));
    expect(hashFrame(Buffer.from("A"))).not.toBe(hashFrame(Buffer.from("B")));
  });
});

describe("classifyDelivery", () => {
  it("maps the before/after hash pair to a verdict", () => {
    expect(classifyDelivery("a", "b")).toBe("landed");
    expect(classifyDelivery("a", "a")).toBe("no-change");
    expect(classifyDelivery(null, "a")).toBe("unknown");
    expect(classifyDelivery("a", null)).toBe("unknown");
  });
});

describe("verifyTouchDelivery", () => {
  it("reports 'landed' when the frame changes, running the action between captures", async () => {
    frameQueue.push("before", "after");
    const order: string[] = [];
    const verdict = await verifyTouchDelivery(apiA, async () => {
      order.push("action");
    });
    expect(verdict).toBe("landed");
    expect(order).toEqual(["action"]); // the touch was injected between the two frames
  });

  it("reports 'no-change' when the frame is identical", async () => {
    // Same frame token before and after: the touch was sent but nothing moved.
    frameQueue.push("frozen", "frozen");
    let injected = false;
    const verdict = await verifyTouchDelivery(apiA, async () => {
      injected = true;
    });
    expect(injected).toBe(true); // the touch was injected
    expect(verdict).toBe("no-change"); // but the screen never changed
  });

  it("degrades to 'unknown' when a frame cannot be captured", async () => {
    frameQueue.push("THROW", "after");
    const verdict = await verifyTouchDelivery(apiA, async () => {});
    expect(verdict).toBe("unknown");
  });

  it("deletes every captured verification frame after hashing it", async () => {
    frameQueue.push("before", "after");
    await verifyTouchDelivery(apiA, async () => {});
    expect(unlinked).toEqual(["before", "after"]);
  });

  it("stands down (verdict 'pointer-active') while the recording pointer overlay is on", async () => {
    // The overlay draws every sent touch into the frame, so a diff would call a
    // dropped touch 'landed'.
    pointerOn = true;
    frameQueue.push("before", "after");
    let injected = false;
    const verdict = await verifyTouchDelivery(apiA, async () => {
      injected = true;
    });
    expect(verdict).toBe("pointer-active");
    expect(injected).toBe(true); // the touch itself still runs
    expect(frameQueue).toHaveLength(2); // and no captures were burned
  });
});

describe("deliveryWarning", () => {
  it("stays silent on a landed touch", () => {
    expect(deliveryWarning("landed")).toBeNull();
  });

  it("points a no-change verdict at the recovery tool when recovery is recommended", () => {
    const warning = deliveryWarning("no-change");
    expect(warning).toMatch(/recover-touch-injection/);
  });

  it("keeps a no-change note soft (no recovery hint) when recovery is not recommended", () => {
    const warning = deliveryWarning("no-change", { recommendRecovery: false });
    expect(warning).not.toMatch(/recover-touch-injection/);
    expect(warning).toMatch(/not conclusive/i);
  });

  it("explains an unknown verdict as a capture failure, not a wedge", () => {
    expect(deliveryWarning("unknown")).toMatch(/could not/i);
  });

  it("explains a pointer-active verdict as the recording overlay masking the check", () => {
    expect(deliveryWarning("pointer-active")).toMatch(/recording/i);
  });
});

describe("runWithDeliveryVerification (automatic first-touch policy)", () => {
  it("auto-verifies the first touch on a device, then stops once delivery is confirmed", async () => {
    frameQueue.push("f1", "f2"); // first touch: frame changes → landed
    const first = await runWithDeliveryVerification(apiA, undefined, async () => {});
    expect(first).toEqual({ verified: true });
    expect(shouldAutoVerify(apiA)).toBe(false);

    // No frames queued: a capture attempt would degrade to 'unknown', so an
    // empty result proves the check was skipped.
    const second = await runWithDeliveryVerification(apiA, undefined, async () => {});
    expect(second).toEqual({});
  });

  it("keeps checking on every no-change touch, but escalates to the recovery hint only once it repeats", async () => {
    frameQueue.push("frozen", "frozen");
    const first = await runWithDeliveryVerification(apiA, undefined, async () => {});
    expect(first.verified).toBe(false);
    expect(first.warning).toBeTruthy();
    expect(first.warning).not.toMatch(/recover-touch-injection/);

    frameQueue.push("frozen", "frozen");
    const second = await runWithDeliveryVerification(apiA, undefined, async () => {});
    expect(second.verified).toBe(false);
    expect(second.warning).toMatch(/recover-touch-injection/);
  });

  it("recommends recovery on the first no-change when the caller explicitly asked (verify:true)", async () => {
    frameQueue.push("frozen", "frozen");
    const forced = await runWithDeliveryVerification(apiA, true, async () => {});
    expect(forced.verified).toBe(false);
    expect(forced.warning).toMatch(/recover-touch-injection/);
  });

  it("stops auto-checking after captures prove unavailable, instead of taxing every touch", async () => {
    frameQueue.push("THROW", "after");
    const first = await runWithDeliveryVerification(apiA, undefined, async () => {});
    expect(first.verified).toBe(false);
    expect(first.warning).toMatch(/could not/i);

    const second = await runWithDeliveryVerification(apiA, undefined, async () => {});
    expect(second).toEqual({}); // no further capture attempts
  });

  it("tracks devices independently: confirming one attach does not skip another", async () => {
    frameQueue.push("a1", "a2");
    await runWithDeliveryVerification(apiA, undefined, async () => {});
    expect(shouldAutoVerify(apiA)).toBe(false);
    expect(shouldAutoVerify(apiB)).toBe(true);

    frameQueue.push("b1", "b2");
    const result = await runWithDeliveryVerification(apiB, undefined, async () => {});
    expect(result).toEqual({ verified: true });
  });

  it("verify:false skips the check entirely, even on the first touch", async () => {
    frameQueue.push("f1", "f2");
    let injected = false;
    const result = await runWithDeliveryVerification(apiA, false, async () => {
      injected = true;
    });
    expect(injected).toBe(true);
    expect(result).toEqual({});
    expect(frameQueue).toHaveLength(2); // untouched — no captures ran
    expect(shouldAutoVerify(apiA)).toBe(true); // and nothing was recorded
  });

  it("verify:true forces a check even after delivery was confirmed", async () => {
    frameQueue.push("f1", "f2");
    await runWithDeliveryVerification(apiA, undefined, async () => {}); // confirms
    frameQueue.push("frozen", "frozen");
    const forced = await runWithDeliveryVerification(apiA, true, async () => {});
    expect(forced.verified).toBe(false);
    expect(forced.warning).toMatch(/recover-touch-injection/);
  });

  it("skips the automatic check silently while the recording pointer is on", async () => {
    pointerOn = true;
    frameQueue.push("f1", "f2");
    const result = await runWithDeliveryVerification(apiA, undefined, async () => {});
    // No verdict or warning on a touch nobody asked to verify; the attach stays
    // unconfirmed so the first post-recording touch is checked.
    expect(result).toEqual({});
    expect(frameQueue).toHaveLength(2);
    expect(shouldAutoVerify(apiA)).toBe(true);
  });

  it("reports pointer-active honestly when the caller explicitly asked to verify", async () => {
    pointerOn = true;
    const result = await runWithDeliveryVerification(apiA, true, async () => {});
    expect(result.verified).toBe(false);
    expect(result.warning).toMatch(/recording/i);
    expect(shouldAutoVerify(apiA)).toBe(true); // transient — not marked unverifiable
  });
});
