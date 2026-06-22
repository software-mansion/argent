import type { DeviceInfo, Registry } from "@argent/registry";
import { UnsupportedOperationError } from "../../../utils/capability";
import { resolveTvApi } from "../../tv/tv-service";
import { TV_DIRECTIONS, type TvDirection } from "../../../blueprints/tv-control-types";
import { TV_BUTTONS, type Button, type ButtonResult } from "../types";

// On a TV target every button is a remote button delivered through the
// focus-driven tv-control backend (injected Siri-remote HID on Apple TV, adb
// keyevents on Android TV), not the touch/key simulator-server. Shared by the
// ios (Apple TV) and android (Android TV) branches, which detect their own TV
// kind and delegate here.
export async function pressTvButton(
  registry: Registry,
  device: DeviceInfo,
  button: Button
): Promise<ButtonResult> {
  if (!TV_BUTTONS.has(button)) {
    throw new UnsupportedOperationError(
      "button",
      device,
      `'${button}' is not a TV remote button — use one of ${TV_DIRECTIONS.join(", ")}`
    );
  }
  const api = await resolveTvApi(registry, device.id);
  await api.navigate(button as TvDirection);
  return { pressed: button };
}
