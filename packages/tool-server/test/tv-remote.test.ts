import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the device round-trip; keep REMOTE_BUTTONS real so the schema enum is genuine.
const injectVegaButtons = vi.fn();
vi.mock("../src/utils/vega-input", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/vega-input")>();
  return { ...actual, injectVegaButtons: (...a: unknown[]) => injectVegaButtons(...a) };
});

import { tvRemoteTool } from "../src/tools/tv-remote";
import { UnsupportedOperationError } from "../src/utils/capability";

// resolveDevice is pure (shape-based), so real udids drive the platform branch.
const VEGA_UDID = "amazon-test01";
const IOS_UDID = "12345678-1234-1234-1234-1234567890ab";

beforeEach(() => {
  injectVegaButtons.mockReset();
  injectVegaButtons.mockResolvedValue(undefined);
});

describe("tv-remote execute", () => {
  it("flattens `repeat` over a single button", async () => {
    const res = await tvRemoteTool.execute({}, { udid: VEGA_UDID, button: "down", repeat: 3 });
    expect(injectVegaButtons).toHaveBeenCalledWith(["down", "down", "down"]);
    expect(res).toEqual({ pressed: ["down", "down", "down"], count: 3 });
  });

  it("flattens `repeat` over a button path and reports the right count", async () => {
    const res = await tvRemoteTool.execute({}, { udid: VEGA_UDID, button: ["up", "down"], repeat: 2 });
    expect(injectVegaButtons).toHaveBeenCalledWith(["up", "down", "up", "down"]);
    expect(res).toEqual({ pressed: ["up", "down", "up", "down"], count: 4 });
  });

  it("defaults to a single press when no repeat is given", async () => {
    const res = await tvRemoteTool.execute({}, { udid: VEGA_UDID, button: "select" });
    expect(injectVegaButtons).toHaveBeenCalledWith(["select"]);
    expect(res.count).toBe(1);
  });

  it("rejects a non-Vega device (internal callers bypass the HTTP capability gate)", async () => {
    await expect(
      tvRemoteTool.execute({}, { udid: IOS_UDID, button: "down" })
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(injectVegaButtons).not.toHaveBeenCalled();
  });
});

describe("tv-remote button schema", () => {
  const schema = tvRemoteTool.zodSchema!;

  it("coerces a JSON-array string back to an array", () => {
    expect(schema.parse({ udid: "x", button: '["up","down"]' }).button).toEqual(["up", "down"]);
  });

  it("coerces a comma-separated string back to an array", () => {
    expect(schema.parse({ udid: "x", button: "up, down" }).button).toEqual(["up", "down"]);
  });

  it("keeps a single button as a scalar", () => {
    expect(schema.parse({ udid: "x", button: "select" }).button).toBe("select");
  });

  it("rejects an unknown button and an empty path", () => {
    expect(() => schema.parse({ udid: "x", button: "nope" })).toThrow();
    expect(() => schema.parse({ udid: "x", button: [] })).toThrow();
  });
});
