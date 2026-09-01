/**
 * The revocation gate at the HTTP edge, in the case where revocation does not
 * work.
 *
 * A provider narrowing or withdrawing a grant only bites because the dispatch
 * edge drops the warm handles first. The capability gate itself runs in the
 * factory and a cached service never re-enters one. So a sweep that cannot
 * finish is not a tidy-up that failed, it is the enforcement point failing and
 * the request behind it has to stop rather than reach a service the provider
 * has taken back.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { Registry } from "@argent/registry";
import { z } from "zod";

const revalidateMock = vi.fn();
const disposeMock = vi.fn();

vi.mock("../src/utils/external-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/external-devices")>();

  return {
    ...actual,
    disposeExternalDeviceServices: (...args: unknown[]) => disposeMock(...args),
    revalidateExternalDevice: (...args: unknown[]) => revalidateMock(...args),
  };
});

import { createHttpApp } from "../src/http";

const DEVICE_ID = "ext:acme-3f2a9c:1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";

/**
 * A tool that reports whether it ran, so "did the request get through" is
 * observable.
 */
function registryWithProbe(ran: { value: boolean }): Registry {
  const registry = new Registry();

  registry.registerTool({
    execute: async () => {
      ran.value = true;
      return { ok: true };
    },
    id: "probe",
    services: () => ({}),
    zodSchema: z.object({ device_id: z.string() }),
  });

  return registry;
}

describe("a revocation sweep that cannot finish stops the request", () => {
  beforeEach(() => {
    revalidateMock.mockReset();
    disposeMock.mockReset();
  });

  it("answers 500 and does not invoke the tool", async () => {
    revalidateMock.mockReturnValue({ reason: "its provider changed what it grants", stale: true });
    disposeMock.mockRejectedValue(new Error("SimulatorServer:ext:acme-3f2a9c:… (teardown wedged)"));

    const ran = { value: false };
    const { app } = createHttpApp(registryWithProbe(ran));

    const res = await request(app).post("/tools/probe").send({ device_id: DEVICE_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/teardown wedged/);
    expect(ran.value).toBe(false);
  });

  it("records the failure under its own signal", async () => {
    revalidateMock.mockReturnValue({ reason: "the device is no longer offered", stale: true });
    disposeMock.mockRejectedValue(new Error("nope"));

    const recordFailure = vi.fn();
    const { app } = createHttpApp(registryWithProbe({ value: false }), { recordFailure });

    await request(app).post("/tools/probe").send({ device_id: DEVICE_ID });

    expect(recordFailure).toHaveBeenCalledWith(
      "probe",
      expect.objectContaining({ device_provider: "acme" }),
      {
        error_code: "EXTERNAL_DEVICE_REVOCATION_INCOMPLETE",
        failure_stage: "external_device_revocation",
        failure_area: "http",
        error_kind: "unknown",
      },
      expect.any(Number)
    );
  });

  /** The control. A sweep that completes hands the call on as it always did. */
  it("dispatches when the sweep completes", async () => {
    revalidateMock.mockReturnValue({ reason: "its provider changed what it grants", stale: true });
    disposeMock.mockResolvedValue([`SimulatorServer:${DEVICE_ID}`]);

    const ran = { value: false };
    const { app } = createHttpApp(registryWithProbe(ran));

    const res = await request(app).post("/tools/probe").send({ device_id: DEVICE_ID });

    expect(res.status).toBe(200);
    expect(ran.value).toBe(true);
  });

  /** Nothing stale means nothing to sweep, so the gate stays out of the way. */
  it("does not sweep at all when the grant is unchanged", async () => {
    revalidateMock.mockReturnValue({ stale: false });

    const ran = { value: false };
    const { app } = createHttpApp(registryWithProbe(ran));

    const res = await request(app).post("/tools/probe").send({ device_id: DEVICE_ID });

    expect(res.status).toBe(200);
    expect(ran.value).toBe(true);
    expect(disposeMock).not.toHaveBeenCalled();
  });
});
