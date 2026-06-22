import type { DeviceInfo, Registry } from "@argent/registry";
import { simulatorServerRef, type SimulatorServerApi } from "../../blueprints/simulator-server";
import { UnsupportedOperationError } from "../../utils/capability";
import { sendCommand } from "../../utils/simulator-client";
import { HARDWARE_BY_PLATFORM, TV_BUTTONS, type Button, type ButtonResult } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Press a phone/tablet hardware button over the simulator-server (Down then
// Up). Shared by the ios and android platform branches — the simulator-server
// transport is identical for both — so it lives here rather than in either
// platform file. Rejects buttons the resolved target doesn't carry.
export async function pressHardwareButton(
  registry: Registry,
  device: DeviceInfo,
  button: Button
): Promise<ButtonResult> {
  if (!HARDWARE_BY_PLATFORM[device.platform].has(button)) {
    const reason = TV_BUTTONS.has(button)
      ? `'${button}' is a TV remote button; this is a ${device.platform} ${device.kind}, not a TV target`
      : `button '${button}' is not available on ${device.platform}`;
    throw new UnsupportedOperationError("button", device, reason);
  }
  const ref = simulatorServerRef(device);
  const api = await registry.resolveService<SimulatorServerApi>(ref.urn, ref.options);
  sendCommand(api, { cmd: "button", direction: "Down", button });
  await sleep(50);
  sendCommand(api, { cmd: "button", direction: "Up", button });
  return { pressed: button };
}
