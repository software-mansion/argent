import { describe, expect, it } from "vitest";
import {
  FAILURE_CODES,
  type FailureSignal,
  type Registry,
  type ToolDefinition,
} from "@argent/registry";
import { createRegistry } from "../src/utils/setup-registry";
import { pasteTool } from "../src/tools/paste";
import { simulatorServerTool } from "../src/tools/simulator/simulator-server";
import { createProposeVariantTool } from "../src/tools/variants/propose-variant";
import { awaitUserSelectionTool } from "../src/tools/variants/await-user-selection";

const failureSignal: FailureSignal = {
  error_code: FAILURE_CODES.ARGENT_UNCLASSIFIED_FAILURE,
  failure_stage: "interaction_message_test",
  failure_area: "tool_server",
  error_kind: "unknown",
};

function definitionsById(registry: Registry): Map<string, ToolDefinition<any, any>> {
  const definitions = new Map<string, ToolDefinition<any, any>>();
  for (const id of registry.getSnapshot().tools) {
    definitions.set(id, registry.getTool(id)!);
  }

  // Lens tools are only registered on macOS; add them explicitly so this test
  // covers the same catalog on every CI platform.
  definitions.set("propose_variant", createProposeVariantTool(registry));
  definitions.set("await_user_selection", awaitUserSelectionTool);

  // These definitions intentionally exist outside createRegistry.
  definitions.set("paste", pasteTool);
  definitions.set("simulator-server", simulatorServerTool);
  return definitions;
}

describe("tool interaction messages", () => {
  it("defines all three formatters for every tool", () => {
    const definitions = definitionsById(createRegistry());
    expect(definitions.size).toBe(78);

    for (const [id, definition] of definitions) {
      expect(definition.interaction?.startedMsg, `${id}.startedMsg`).toBeTypeOf("function");
      expect(definition.interaction?.completedMsg, `${id}.completedMsg`).toBeTypeOf("function");
      expect(definition.interaction?.failedMsg, `${id}.failedMsg`).toBeTypeOf("function");
    }
  });

  it("formats messages from parameters, results, and failure signals", () => {
    const definitions = definitionsById(createRegistry());

    expect(
      definitions.get("gesture-tap")!.interaction!.completedMsg!({
        params: { udid: "device-1", x: 0.5, y: 0.25, clickCount: 2 },
        result: {},
      })
    ).toBe("Double-tapped at (50%, 25%)");

    expect(
      definitions.get("screenshot")!.interaction!.completedMsg!({
        params: { udid: "device-1" },
        result: { image: { filename: "screenshot.png" } },
      })
    ).toBe("Captured screenshot screenshot.png");

    expect(
      definitions.get("gesture-tap")!.interaction!.failedMsg!({
        params: { udid: "device-1", x: 0.5, y: 0.25 },
        error: new Error("raw error"),
        failureSignal,
      })
    ).toBe(`Failed to tap at (50%, 25%): ${failureSignal.error_code}`);
  });

  it("does not expose sensitive inputs", () => {
    const definitions = definitionsById(createRegistry());
    const secret = "INTERACTION_MESSAGE_SECRET";
    const messages = [
      definitions.get("keyboard")!.interaction!.startedMsg!({
        params: { udid: "device-1", text: secret, key: secret },
      }),
      definitions.get("open-url")!.interaction!.startedMsg!({
        params: {
          udid: "device-1",
          url: `https://user:${secret}@example.com/path?token=${secret}#fragment`,
        },
      }),
      definitions.get("debugger-evaluate")!.interaction!.startedMsg!({
        params: { device_id: "device-1", port: 8081, expression: secret },
      }),
      definitions.get("chromium-cookies")!.interaction!.completedMsg!({
        params: { udid: "chromium-1", action: "set", name: "session", value: secret },
        result: { set: true },
      }),
      definitions.get("flow-add-echo")!.interaction!.completedMsg!({
        params: { message: secret },
        result: { message: secret, flowFile: "/tmp/flow.yaml", savedTo: "project" },
      }),
    ];

    expect(messages.join("\n")).not.toContain(secret);
    expect(messages).toContain("Opening example.com");
  });
});
