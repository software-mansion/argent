import { describe, it, expect, vi, beforeEach } from "vitest";

// The handler shells out via vegaDevice; mock it so we can feed crafted install-app
// output and assert success/failure detection deterministically.
const vegaDevice = vi.fn();
vi.mock("../src/utils/vega-cli", () => ({ vegaDevice: (...a: unknown[]) => vegaDevice(...a) }));

import type { DeviceInfo } from "@argent/registry";
import { vegaImpl } from "../src/tools/reinstall-app/platforms/vega";
import type { ReinstallAppParams, ReinstallAppServices } from "../src/tools/reinstall-app/types";

const SERVICES: ReinstallAppServices = {};
const PARAMS: ReinstallAppParams = {
  udid: "amazon-1",
  bundleId: "com.example.app.main",
  appPath: "/tmp/app.vpkg",
};
// The handler ignores device/options; a stub satisfies the (services, params, device) arity.
const DEVICE = { platform: "vega", kind: "vvd", udid: "amazon-1" } as unknown as DeviceInfo;

// The handler's uninstall-app result is swallowed (.catch), so returning the same
// value for every call is fine — only the install-app output drives the result.
let installOutput = { stdout: "", stderr: "" };
function mockInstallOutput(stdout: string, stderr = ""): void {
  installOutput = { stdout, stderr };
}

beforeEach(() => {
  vegaDevice.mockReset();
  vegaDevice.mockImplementation(async () => installOutput);
});

describe("vega reinstall — install-app result detection", () => {
  it("rejects multi-phase output where a later phase fails after an earlier ...success", async () => {
    // The exact shape from the review: an early phase succeeds, a later one fails.
    mockInstallOutput("Installing 'app' ...success\nActivating 'app' ...failed\n");
    await expect(vegaImpl.handler(SERVICES, PARAMS, DEVICE)).rejects.toThrow(/install-app failed/i);
  });

  it("accepts a clean single-phase success", async () => {
    mockInstallOutput("Installing 'app' ...success\n");
    await expect(vegaImpl.handler(SERVICES, PARAMS, DEVICE)).resolves.toMatchObject({ reinstalled: true });
  });

  it("rejects when no phase reports success", async () => {
    mockInstallOutput("Installing 'app' ...failed\n");
    await expect(vegaImpl.handler(SERVICES, PARAMS, DEVICE)).rejects.toThrow(/install-app failed/i);
  });
});
