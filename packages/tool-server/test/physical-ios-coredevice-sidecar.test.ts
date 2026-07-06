/**
 * Coverage for the physical-iOS (CoreDevice) backend after it moved from a
 * per-call `pymobiledevice3` CLI spawn to a persistent stdio sidecar:
 *
 *  - `adaptSpringboardToDescribeResult` — the SpringBoard home-screen → describe
 *    tree adapter that backs `describe` on a real iPhone (in-app AX is Apple-
 *    gated). Frames are grid-derived; this pins the layout math (widget spans
 *    push icons down; dock sits at the bottom; every frame stays in [0,1]).
 *  - `agentError` — the 9021 (iOS-27 host-input gate) message mapping.
 *  - `CoreDeviceAgent` — the stdio JSON protocol: ready handshake, id-correlated
 *    request/response, and error propagation (via a stand-in node process).
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { adaptSpringboardToDescribeResult } from "../src/tools/describe/platforms/ios/ios-springboard-adapter";
import { agentError } from "../src/blueprints/core-device";
import { CoreDeviceAgent, CoreDeviceAgentError } from "../src/blueprints/coredevice-agent";

const METRICS = {
  homeScreenIconColumns: 4,
  homeScreenIconRows: 6,
  homeScreenWidth: 393,
  homeScreenHeight: 852,
  homeScreenIconDockMaxCount: 4,
};

const leaf = (name: string, id: string) => ({ displayName: name, bundleIdentifier: id });
const widget = (size: string) => ({ iconType: "custom", gridSize: size });

// Two 2x2 "small" widgets fill the top two rows; the first app row therefore
// starts at grid row 2. A second page must NOT appear (it's off-screen).
const ICON_STATE = [
  [leaf("Phone", "com.apple.mobilephone"), leaf("Safari", "com.apple.mobilesafari")], // dock
  [
    widget("small"),
    widget("small"),
    leaf("FaceTime", "com.apple.facetime"),
    leaf("Maps", "com.apple.Maps"),
  ],
  [leaf("OffPage", "com.example.offpage")], // page 2, not rendered
];

interface Node {
  role: string;
  frame: { x: number; y: number; width: number; height: number };
  children: Node[];
  label?: string;
  identifier?: string;
}
function flatten(n: Node, out: Node[] = []): Node[] {
  out.push(n);
  for (const c of n.children) flatten(c, out);
  return out;
}
const center = (f: Node["frame"]) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });

describe("adaptSpringboardToDescribeResult", () => {
  const tree = adaptSpringboardToDescribeResult({ iconState: ICON_STATE, metrics: METRICS });
  const nodes = flatten(tree as Node);
  const byLabel = (l: string) => nodes.find((n) => n.label === l);

  it("returns leaf icons with label + bundle identifier", () => {
    const faceTime = byLabel("FaceTime");
    expect(faceTime?.identifier).toBe("com.apple.facetime");
    expect(byLabel("Phone")?.identifier).toBe("com.apple.mobilephone");
  });

  it("packs the first app below the two 2x2 widgets (widgets occupy the top rows)", () => {
    // FaceTime is item 3 on the page but the two small widgets take rows 0-1,
    // so it lands on row 2 — visibly below the widgets, not at the very top.
    const widgets = nodes.filter((n) => n.role === "AXGroup" && n !== tree);
    expect(widgets).toHaveLength(2);
    const widgetBottom = Math.max(...widgets.map((w) => w.frame.y + w.frame.height));
    const faceTime = byLabel("FaceTime")!;
    expect(center(faceTime.frame).y).toBeGreaterThan(widgetBottom - 0.01);
  });

  it("places the dock along the bottom", () => {
    expect(center(byLabel("Phone")!.frame).y).toBeGreaterThan(0.85);
    expect(center(byLabel("Safari")!.frame).y).toBeGreaterThan(0.85);
  });

  it("omits off-screen pages (only the first home page + dock)", () => {
    expect(byLabel("OffPage")).toBeUndefined();
  });

  it("keeps every frame within the normalized [0,1] box", () => {
    for (const n of nodes) {
      const { x, y, width, height } = n.frame;
      for (const v of [x, y, width, height]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(x + width).toBeLessThanOrEqual(1.0001);
      expect(y + height).toBeLessThanOrEqual(1.0001);
    }
  });

  it("does not throw on empty / malformed icon state", () => {
    expect(() => adaptSpringboardToDescribeResult({ iconState: [], metrics: {} })).not.toThrow();
    expect(() =>
      adaptSpringboardToDescribeResult({ iconState: null, metrics: METRICS })
    ).not.toThrow();
  });
});

describe("agentError — iOS-27 host-input gate (CoreDeviceError 9021)", () => {
  it("maps a gated agent error to the actionable iOS-27 message", () => {
    const e = agentError("tap", new CoreDeviceAgentError("… CoreDeviceError 9021 …", true));
    expect(e.message).toContain("requires iOS 27+");
    expect(getFailureSignal(e)?.error_code).toBe(FAILURE_CODES.CORE_DEVICE_IOS_VERSION_TOO_OLD);
  });

  it("maps a non-gated agent error to a generic command failure", () => {
    const e = agentError("swipe", new CoreDeviceAgentError("some other failure", false));
    expect(e.message).toContain("CoreDevice swipe failed");
    expect(e.message).not.toContain("iOS 27");
    expect(getFailureSignal(e)?.error_code).toBe(FAILURE_CODES.CORE_DEVICE_COMMAND_FAILED);
  });

  it("maps a plain Error to a command failure", () => {
    const e = agentError("button", new Error("boom"));
    expect(getFailureSignal(e)?.error_code).toBe(FAILURE_CODES.CORE_DEVICE_COMMAND_FAILED);
  });
});

describe("CoreDeviceAgent — stdio JSON protocol", () => {
  // A stand-in for the python agent: emits the ready handshake, echoes ops, and
  // returns a gated error for op "fail". Run with node so the test needs no
  // device or pymobiledevice3.
  const mock = join(tmpdir(), `argent-mock-coredevice-agent-${process.pid}.cjs`);
  writeFileSync(
    mock,
    `const rl = require("readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.op === "fail") {
    process.stdout.write(JSON.stringify({ id: m.id, error: "CoreDeviceError 9021", gated_9021: true }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ id: m.id, ok: true, echo: m.op }) + "\\n");
  }
});
`
  );

  it("handshakes, correlates responses by id, and propagates errors", async () => {
    const agent = new CoreDeviceAgent(process.execPath, mock, "UDID", 49151, 5000);
    await agent.start();
    try {
      const r = await agent.request("ping");
      expect(r.ok).toBe(true);
      expect(r.echo).toBe("ping");

      await expect(agent.request("fail")).rejects.toMatchObject({
        name: "CoreDeviceAgentError",
        gated9021: true,
      });
    } finally {
      agent.dispose();
    }
  });

  it("rejects a request made after dispose", async () => {
    const agent = new CoreDeviceAgent(process.execPath, mock, "UDID", 49151, 5000);
    await agent.start();
    agent.dispose();
    await expect(agent.request("ping")).rejects.toThrow();
  });
});
