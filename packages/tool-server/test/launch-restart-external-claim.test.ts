/**
 * launch-app and restart-app skip the native-devtools precheck on a
 * provider-supplied device, because injection is a grant most providers
 * withhold and resolving it would fail an otherwise fine launch.
 *
 * The skip used to key on the `ext:` spelling. The same simulator named by its
 * raw udid took the other branch and failed on the withheld grant, so whether
 * an app launched depended only on which of the device's two names the caller
 * happened to use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      execFileMock(cmd, args);
      callback(null, { stdout: "", stderr: "" });
    },
  };
});

import type { Registry } from "@argent/registry";
import { makeIosImpl as makeLaunchIosImpl } from "../src/tools/launch-app/platforms/ios";
import { makeIosImpl as makeRestartIosImpl } from "../src/tools/restart-app/platforms/ios";
import { resolveDevice } from "../src/utils/device-info";
import {
  __resetExternalDeviceCacheForTesting,
  __resetProviderWarningsForTesting,
  makeExternalId,
} from "../src/utils/external-devices";

const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";
const PROVIDER_ID = "acme-3f2a9c";
const DEVICE_ID = makeExternalId(PROVIDER_ID, IOS_UDID);
const BUNDLE_ID = "com.example.app";

let temporaryDirectory: string;

/** A descriptor granting `simctl` but deliberately withholding injection. */
function publishDescriptor(): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities: ["simctl"],
          kind: "simulator",
          name: "iPhone 16 Pro",
          nativeId: IOS_UDID,
          platform: "ios",
          state: "Booted",
        },
      ],
      id: PROVIDER_ID,
      name: "Acme IDE",
      schemaVersion: 1,
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
}

/** Resolving anything through this is the failure the tests watch for. */
function refusingRegistry(): { registry: Registry; resolveService: ReturnType<typeof vi.fn> } {
  const resolveService = vi.fn(async () => {
    throw new Error("native-devtools must not be resolved on a provider's device");
  });

  return { registry: { resolveService } as unknown as Registry, resolveService };
}

beforeEach(() => {
  execFileMock.mockReset();
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-launch-claim-"));
  __resetExternalDeviceCacheForTesting();
  __resetProviderWarningsForTesting();
  publishDescriptor();
});

afterEach(() => {
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
  fs.rmSync(temporaryDirectory, { force: true, recursive: true });
});

describe("launch-app and restart-app on a device a provider claims", () => {
  it.each([
    ["the ext: id", DEVICE_ID],
    ["the raw udid", IOS_UDID],
  ])("launches through %s without resolving native-devtools", async (_label, udid) => {
    const { registry, resolveService } = refusingRegistry();

    const result = await makeLaunchIosImpl(registry).handler(
      {},
      { udid, bundleId: BUNDLE_ID },
      resolveDevice(udid)
    );

    expect(result).toEqual({ launched: true, bundleId: BUNDLE_ID });
    expect(resolveService).not.toHaveBeenCalled();
    /** Both spellings reach simctl as the provider's real udid. */
    expect(execFileMock).toHaveBeenCalledWith("xcrun", ["simctl", "launch", IOS_UDID, BUNDLE_ID]);
  });

  it.each([
    ["the ext: id", DEVICE_ID],
    ["the raw udid", IOS_UDID],
  ])("restarts through %s without resolving native-devtools", async (_label, udid) => {
    const { registry, resolveService } = refusingRegistry();

    await makeRestartIosImpl(registry).handler(
      {},
      { udid, bundleId: BUNDLE_ID },
      resolveDevice(udid)
    );

    expect(resolveService).not.toHaveBeenCalled();
  });

  it("still resolves native-devtools for a device argent booted itself", async () => {
    const unclaimed = "99999999-9999-9999-9999-999999999999";
    const { registry, resolveService } = refusingRegistry();

    await expect(
      makeLaunchIosImpl(registry).handler(
        {},
        { udid: unclaimed, bundleId: BUNDLE_ID },
        resolveDevice(unclaimed)
      )
    ).rejects.toThrow(/native-devtools must not be resolved/);

    expect(resolveService).toHaveBeenCalled();
  });
});
