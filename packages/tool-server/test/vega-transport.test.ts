import { describe, it, expect, vi, beforeEach } from "vitest";

// The transport talks to the on-device agent via the lifecycle singleton; mock
// it so we can drive `client.cmd` outcomes without a real device.
const cmd = vi.fn();
const close = vi.fn();
const getOrStartVegaAgent = vi.fn();
const invalidateVegaAgent = vi.fn();

vi.mock("../src/utils/vega-agent-manager", () => ({
  getOrStartVegaAgent: (...a: unknown[]) => getOrStartVegaAgent(...a),
  invalidateVegaAgent: (...a: unknown[]) => invalidateVegaAgent(...a),
}));

import { resolveVegaTransport } from "../src/utils/vega-transport";
import { VegaAgentTransportError } from "../src/utils/vega-agent-client";

const LONG_XML = '<?xml version="1.0"?><root>' + "x".repeat(100) + "</root>";

beforeEach(() => {
  cmd.mockReset();
  close.mockReset();
  getOrStartVegaAgent.mockReset();
  invalidateVegaAgent.mockReset();
  getOrStartVegaAgent.mockResolvedValue({
    client: { cmd, close },
    emuSerial: "emulator-5554",
    hostPort: 12345,
  });
});

describe("resolveVegaTransport: pressButtons", () => {
  it("maps remote buttons to KEY_ codes in one agent call", async () => {
    cmd.mockResolvedValue(undefined);
    const transport = await resolveVegaTransport("amazon-x");
    const count = await transport.pressButtons(["up", "select"]);
    expect(count).toBe(2);
    expect(cmd).toHaveBeenCalledWith("button", { keys: ["KEY_UP", "KEY_ENTER"] });
  });
});

describe("resolveVegaTransport: getPageSource", () => {
  it("returns ok with the XML for a served page source", async () => {
    cmd.mockResolvedValue({ xml: LONG_XML });
    const transport = await resolveVegaTransport("amazon-x");
    expect(await transport.getPageSource()).toEqual({ ok: true, xml: LONG_XML });
    expect(cmd).toHaveBeenCalledWith("getPageSource");
  });

  it("reports toolkit-unavailable for an empty/too-short root", async () => {
    cmd.mockResolvedValue({ xml: "<root/>" });
    const transport = await resolveVegaTransport("amazon-x");
    expect(await transport.getPageSource()).toEqual({ ok: false, reason: "toolkit-unavailable" });
  });

  it("reports toolkit-unavailable when the agent returns no xml", async () => {
    cmd.mockResolvedValue({});
    const transport = await resolveVegaTransport("amazon-x");
    expect(await transport.getPageSource()).toEqual({ ok: false, reason: "toolkit-unavailable" });
  });
});

describe("resolveVegaTransport: agent restart policy", () => {
  it("restarts the agent once and retries on a transport fault", async () => {
    cmd
      .mockRejectedValueOnce(new VegaAgentTransportError("socket hang up"))
      .mockResolvedValueOnce({ xml: LONG_XML });
    const transport = await resolveVegaTransport("amazon-x");
    expect(await transport.getPageSource()).toEqual({ ok: true, xml: LONG_XML });
    expect(invalidateVegaAgent).toHaveBeenCalledTimes(1);
    expect(cmd).toHaveBeenCalledTimes(2);
  });

  it("does not restart on a logical command error — it rethrows", async () => {
    cmd.mockRejectedValue(new Error("AgentError: bad op"));
    const transport = await resolveVegaTransport("amazon-x");
    await expect(transport.getPageSource()).rejects.toThrow(/bad op/);
    expect(invalidateVegaAgent).not.toHaveBeenCalled();
    expect(cmd).toHaveBeenCalledTimes(1);
  });
});
