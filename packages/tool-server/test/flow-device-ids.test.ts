import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Registry } from "@argent/registry";

const invokeSubTool = vi.fn();

vi.mock("../src/utils/sub-invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sub-invoke")>()),
  invokeSubTool: (...a: unknown[]) => invokeSubTool(...a),
}));

import { resolveFlowDevice } from "../src/tools/flows/flow-device";

/** What `list-devices` emits for a phone on `hdc` — keyed by `udid`, as iOS is. */
const HARMONY_ENTRY = {
  platform: "harmony",
  kind: "device",
  udid: "harmony-127.0.0.1:5555",
  state: "Connected",
};

/**
 * A remote simulator: also keyed by `udid`, also not auto-resolvable, and — like
 * harmony — a platform `fetchFlowTree` has no arm for, so a flow named against
 * one runs its coordinate steps and fails its selector steps.
 */
const IOS_REMOTE_ENTRY = {
  platform: "ios-remote",
  udid: "remote-6DBF83B4-0000-0000-0000-000000000000",
  state: "Shutdown",
};

describe("flow device resolution — ids of platforms no flow auto-resolves", () => {
  it("names each device by the id it is listed under when nothing resolves", async () => {
    // Neither is auto-resolvable, so this host resolves nothing and the error
    // falls back to enumerating what there is. That
    // enumeration exists to name what the caller can pass; rendering a device
    // as `?` leaves them nothing to retry with.
    invokeSubTool.mockResolvedValue({ devices: [HARMONY_ENTRY, IOS_REMOTE_ENTRY] });

    await expect(resolveFlowDevice({} as Registry, undefined, {})).rejects.toThrow(
      "Available devices: harmony-127.0.0.1:5555 (harmony, Connected), " +
        "remote-6DBF83B4-0000-0000-0000-000000000000 (ios-remote, Shutdown)."
    );
  });

  it("never adopts one as the booted device it resolved by itself", async () => {
    // Naming the id is not auto-resolution: `isBooted` has an arm for neither,
    // so such an entry is never the single booted device a flow silently
    // targets. Passing one EXPLICITLY is a different question and deliberately
    // still allowed — measured on 6.1.1, a harmony run degrades per step (a
    // coordinate `tap` passes, `snapshot` captures and keys a baseline, a
    // selector step errors) rather than dead-ending, so a blanket refusal here
    // would take away runs that work.
    invokeSubTool.mockResolvedValue({ devices: [HARMONY_ENTRY] });

    await expect(resolveFlowDevice({} as Registry, undefined, {})).rejects.toThrow(
      /No booted device found/
    );
  });
});
