/**
 * `bootIos` shuts a simulator down and boots it again, so `boot-device` is the
 * one tool that could take a provider's device away. The promise ("Argent will
 * never kill, boot, reboot or shut down your device") is about the device, so
 * the refusal has to hold for its real udid as well as its `ext:` id;
 * `ios.additionalDeviceSets` surfaces such a simulator by raw udid.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFailureSignal, type Registry } from "@argent/registry";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { makeExternalId } from "../src/utils/external-devices";

const registry = {} as Registry;
const IOS_UDID = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809";

let temporaryDirectory: string;

function publishDescriptor(): void {
  const descriptorPath = path.join(temporaryDirectory, "acme.json");

  fs.writeFileSync(
    descriptorPath,
    JSON.stringify({
      devices: [
        {
          capabilities: ["simctl", "ax-service"],
          kind: "simulator",
          name: "iPhone 16 Pro",
          nativeId: IOS_UDID,
          platform: "ios",
          state: "Booted",
        },
      ],
      id: "acme-3f2a9c",
      name: "Acme IDE",
      pid: process.pid,
      schemaVersion: 1,
    })
  );

  process.env.ARGENT_DEVICE_PROVIDERS = descriptorPath;
  delete process.env.ARGENT_DISABLE_DEVICE_PROVIDERS;
}

/** The refusal's message and failure code or a test failure if it booted. */
async function bootFailure(params: Record<string, unknown>): Promise<{
  code: string | undefined;
  message: string;
}> {
  try {
    await createBootDeviceTool(registry).execute!({}, params);
  } catch (error) {
    return {
      code: getFailureSignal(error)?.error_code,
      message: (error as Error).message,
    };
  }

  throw new Error(`boot-device did not refuse ${JSON.stringify(params)}`);
}

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "argent-boot-refused-"));
});

afterEach(() => {
  delete process.env.ARGENT_DEVICE_PROVIDERS;
  process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("boot-device on a provider's device", () => {
  it("refuses the ext: id", async () => {
    publishDescriptor();

    const failure = await bootFailure({ udid: makeExternalId("acme-3f2a9c", IOS_UDID) });

    expect(failure.code).toBe("EXTERNAL_DEVICE_LIFECYCLE_REFUSED");
    expect(failure.message).toMatch(/owns its lifecycle/);
  });

  /** The reboot is what the promise forbids; the spelling is incidental. */
  it("refuses the raw udid of the same device, naming the provider", async () => {
    publishDescriptor();

    const failure = await bootFailure({ udid: IOS_UDID });

    expect(failure.code).toBe("EXTERNAL_DEVICE_LIFECYCLE_REFUSED");
    expect(failure.message).toMatch(/supplied by Acme IDE/);
  });

  it("refuses it with force, which is the flag that would reboot it", async () => {
    publishDescriptor();

    const failure = await bootFailure({ udid: IOS_UDID, force: true });

    expect(failure.code).toBe("EXTERNAL_DEVICE_LIFECYCLE_REFUSED");
  });
});
