import { describe, it, expect, vi, beforeEach } from "vitest";

// A remote foldable is folded by `sim-remote fold --json`, which answers once
// the device has handed over to the other panel. These tests pin the argv and
// the result an agent reads, which has the shape of a local iOS fold.
const calls: Array<{ cmd: string; args: readonly string[] }> = [];
let reply: { stdout: string } | { error: string } = { stdout: "" };

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      _opts: unknown,
      cb?: (err: Error | null, out?: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof _opts === "function" ? _opts : cb!;
      calls.push({ cmd, args });
      if ("error" in reply) {
        callback(Object.assign(new Error("exit 1"), { stderr: reply.error }));
      } else {
        callback(null, { stdout: reply.stdout, stderr: "" });
      }
    },
  };
});

const holds: number[] = [];
vi.mock("../src/utils/timing", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/timing")>("../src/utils/timing");
  return {
    ...actual,
    sleepOrAbort: async (ms: number) => {
      holds.push(ms);
      return true;
    },
  };
});

vi.mock("../src/utils/check-deps", () => ({ ensureDeps: async () => {} }));

import { foldTool } from "../src/tools/fold";
import { INPUT_READY_HOLD_MID_ANGLE_MS, INPUT_READY_HOLD_MS } from "../src/utils/foldable";

const UDID = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const REMOTE = `remote:${UDID}`;

function fold(params: { posture?: "closed" | "half-open" | "open"; angle?: number }) {
  return foldTool.execute!({}, { udid: REMOTE, ...params });
}

beforeEach(() => {
  calls.length = 0;
  holds.length = 0;
});

describe("fold on a remote simulator", () => {
  it("needs no simulator-server of its own", () => {
    expect(foldTool.services!({ udid: REMOTE, posture: "open" })).toEqual({});
  });

  it("folds through sim-remote and names the panel the device renders to", async () => {
    reply = { stdout: '{"hinge_angle":180.0,"live_screen":3}\n' };

    const result = await fold({ posture: "open" });

    expect(calls).toEqual([{ cmd: "sim-remote", args: ["fold", UDID, "open", "--json"] }]);
    expect(result).toEqual({
      activeScreen: 3,
      screen: { id: 3, panel: "inner panel" },
      posture: "open",
      hingeAngle: 180,
    });
    expect(holds).toEqual([INPUT_READY_HOLD_MS]);
  });

  it("passes an angle on in degrees and holds longer short of a stop", async () => {
    reply = { stdout: '{"hinge_angle":90.0,"live_screen":3}' };

    const result = await fold({ angle: 90 });

    expect(calls[0]!.args).toEqual(["fold", UDID, "90", "--json"]);
    expect(result).toEqual({
      activeScreen: 3,
      screen: { id: 3, panel: "inner panel" },
      hingeAngle: 90,
    });
    expect(holds).toEqual([INPUT_READY_HOLD_MID_ANGLE_MS]);
  });

  it("falls back to the cover panel and passes the warning on when the panel is unknown", async () => {
    reply = {
      stdout: '{"hinge_angle":0.0,"live_screen":null,"warning":"the host could not tell"}',
    };

    const result = await fold({ posture: "closed" });

    expect(result).toEqual({
      activeScreen: 1,
      screen: { id: 1, panel: "cover panel" },
      posture: "closed",
      hingeAngle: 0,
      warning: "the host could not tell",
    });
  });

  it("fails in the runner's words for a device that is not foldable", async () => {
    reply = { error: "the hinge can only be moved on a foldable iOS simulator" };

    await expect(fold({ posture: "open" })).rejects.toThrow(
      "the hinge can only be moved on a foldable iOS simulator"
    );
  });
});
