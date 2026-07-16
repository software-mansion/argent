/**
 * Coverage for the physical-iOS (CoreDevice) backend after it moved from a
 * per-call `pymobiledevice3` CLI spawn to a persistent stdio sidecar:
 *
 *  - `adaptCoreDeviceAxToDescribeResult` — the axAudit accessibility tree →
 *    describe adapter that backs `describe` on a real iPhone. Pins caption→role
 *    parsing, label cleanup, rect normalization, and frame interpolation for the
 *    elements the audit didn't rect (every frame stays in [0,1]).
 *  - `agentError` — the 9021 (iOS-27 host-input gate) message mapping.
 *  - `CoreDeviceAgent` — the stdio JSON protocol: ready handshake, id-correlated
 *    request/response, and error propagation (via a stand-in node process).
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { adaptCoreDeviceAxToDescribeResult } from "../src/tools/describe/platforms/ios/ios-coredevice-ax-adapter";
import { agentError } from "../src/blueprints/core-device";
import {
  CoreDeviceAgent,
  CoreDeviceAgentError,
  coreDeviceAgentScript,
} from "../src/blueprints/coredevice-agent";

describe("embedded agent script", () => {
  it("AGENT_SCRIPT_B64 matches coredevice-agent.py (regenerate after editing the .py)", () => {
    const py = readFileSync(join(__dirname, "../src/blueprints/coredevice-agent.py"), "utf8");
    expect(coreDeviceAgentScript()).toBe(py);
  });
});

interface Node {
  role: string;
  frame: { x: number; y: number; width: number; height: number };
  children: Node[];
  label?: string;
}
function flatten(n: Node, out: Node[] = []): Node[] {
  out.push(n);
  for (const c of n.children) flatten(c, out);
  return out;
}
const center = (f: Node["frame"]) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 });

// A realistic axAudit snapshot: some elements carry an audit rect (points on a
// 393x852 screen), others don't (interpolated by the adapter).
const AXTREE = {
  screen: { w: 393, h: 852 },
  elements: [
    { caption: "Settings, Button", id: "a1", rect: "{{318, 63}, {55, 36}}" },
    { caption: "Wi-Fi, Header", id: "a2", rect: "{{32, 168}, {55, 26}}" },
    { caption: "Wi-Fi, 1, Button, Toggle", id: "a3" }, // no rect -> interpolated
    { caption: "Other…, Button", id: "a4", rect: "{{16, 553}, {361, 52}}" },
    { caption: "Known networks will be joined automatically.", id: "a5" }, // static text
  ],
};

describe("adaptCoreDeviceAxToDescribeResult", () => {
  const tree = adaptCoreDeviceAxToDescribeResult(AXTREE);
  const nodes = flatten(tree as Node);
  const byLabel = (l: string) => nodes.find((n) => n.label === l);

  it("parses roles from caption traits and strips them from the label", () => {
    expect(byLabel("Settings")?.role).toBe("AXButton");
    expect(byLabel("Wi-Fi")?.role).toBe("AXHeader");
    // Button trait wins the role; trailing Button/Toggle stripped from the label.
    expect(byLabel("Wi-Fi, 1")?.role).toBe("AXButton");
    // No trait -> static text, full caption kept as label.
    const stat = nodes.find((n) => n.label?.startsWith("Known networks"));
    expect(stat?.role).toBe("AXStaticText");
  });

  it("normalizes an audited rect (points) into a [0,1] frame", () => {
    const other = byLabel("Other…")!;
    // {{16, 553}, {361, 52}} on 393x852
    expect(other.frame.x).toBeCloseTo(16 / 393, 3);
    expect(other.frame.y).toBeCloseTo(553 / 852, 3);
    expect(other.frame.width).toBeCloseTo(361 / 393, 3);
  });

  it("interpolates a rect-less element between its neighbours (reading order)", () => {
    const wifiHeader = center(byLabel("Wi-Fi")!.frame).y; // ~168/852
    const other = center(byLabel("Other…")!.frame).y; // ~553/852
    const toggle = center(byLabel("Wi-Fi, 1")!.frame).y; // no rect, between the two
    expect(toggle).toBeGreaterThan(wifiHeader);
    expect(toggle).toBeLessThan(other);
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

  it("does not throw on an empty / screen-less tree", () => {
    expect(() => adaptCoreDeviceAxToDescribeResult({ elements: [] })).not.toThrow();
    expect(() =>
      adaptCoreDeviceAxToDescribeResult({
        elements: [{ caption: "x", id: "1" }],
      })
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
