import { describe, it, expect, vi, beforeEach } from "vitest";

// listVegaDevices fans out to the vega CLI + SDK image dir; mock those so we can
// drive the running-VVD image-resolution path deterministically.
const resolveVegaBinary = vi.fn();
const runVega = vi.fn();
const runVegaDevice = vi.fn();
const listVvdImages = vi.fn();

vi.mock("../src/utils/vega-cli", () => ({
  resolveVegaBinary: (...a: unknown[]) => resolveVegaBinary(...a),
  runVega: (...a: unknown[]) => runVega(...a),
  runVegaDevice: (...a: unknown[]) => runVegaDevice(...a),
}));
vi.mock("../src/utils/vega-sdk", () => ({
  listVvdImages: (...a: unknown[]) => listVvdImages(...a),
}));
vi.mock("../src/utils/vega-process", () => ({
  listRunningVvdConsolePorts: vi.fn(async () => new Set<number>()),
}));

import { listVegaDevices } from "../src/utils/vega-devices";

beforeEach(() => {
  vi.clearAllMocks();
  resolveVegaBinary.mockResolvedValue("/usr/bin/vega");
});

// One running VirtualDevice row (serial is the trailing token).
function deviceListRow(serial = "amazon-abc") {
  return {
    stdout: `Found the following device:\nVirtualDevice : tv - aarch64 - OS - ${serial}\n`,
    stderr: "",
  };
}
function info(profile: string) {
  return {
    stdout: JSON.stringify({ profile, simulated: true, hostname: "amazon-abc" }),
    stderr: "",
  };
}

describe("listVegaDevices — running-VVD image resolution", () => {
  it("reports vvdImage: null (not a bogus profile) when the running image can't be confirmed", async () => {
    runVega.mockResolvedValue(deviceListRow());
    // profile does not match any installed image dir name, and 2+ images are installed,
    // so the single-image fallback can't rescue it.
    runVegaDevice.mockResolvedValue(info("vvrp_internal_xyz"));
    listVvdImages.mockResolvedValue([
      { name: "tv", path: "/i/tv" },
      { name: "tablet", path: "/i/tablet" },
    ]);

    const devices = await listVegaDevices();
    const running = devices.find((d) => d.state === "running");
    expect(running?.kind).toBe("vvd");
    // Was the raw, non-installed profile (a value boot-device cannot start); now null.
    expect(running?.vvdImage).toBeNull();
  });

  it("still resolves and dedups the running image when the profile matches an installed image", async () => {
    runVega.mockResolvedValue(deviceListRow());
    runVegaDevice.mockResolvedValue(info("tv"));
    listVvdImages.mockResolvedValue([
      { name: "tv", path: "/i/tv" },
      { name: "tablet", path: "/i/tablet" },
    ]);

    const devices = await listVegaDevices();
    const running = devices.find((d) => d.state === "running");
    expect(running?.vvdImage).toBe("tv");
    // The resolvable case still dedups: only "tablet" remains stopped, no phantom "tv".
    const stoppedNames = devices.filter((d) => d.state === "stopped").map((d) => d.vvdImage);
    expect(stoppedNames).toEqual(["tablet"]);
  });
});
