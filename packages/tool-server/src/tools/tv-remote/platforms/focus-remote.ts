import type { DeviceInfo, Registry } from "@argent/registry";
import { resolveTvApi } from "../../tv/tv-service";
import { UnsupportedOperationError } from "../../../utils/capability";
import type { RemoteButton } from "../../../utils/vega-input";
import { expandButtons, type TvRemoteParams, type TvRemoteResult } from "../types";

// Shared Apple TV (tvOS) / Android TV (leanback) remote path. Both expose the
// same focus-driven `TvControlApi`, whose `navigate` accepts the full remote
// vocabulary (`TvDirection` === `RemoteButton`). Presses go one at a time over
// the daemon / `adb` (there is no batched path like Vega's `inputd-cli`), but
// the whole sequence still runs in this single tool call.
//
// `unsupported` lets a platform reject buttons its backend can't honor *before*
// any press fires (so a path doesn't half-execute). Apple TV uses it for the
// media-transport / volume keys: the tvOS simulator's HID stack ignores
// Consumer Control (page 0x0C) events, so injecting them is a silent no-op that
// would otherwise report false success. Android TV passes nothing — every key
// maps to a real `adb input keyevent`.
export async function pressFocusRemote(
  registry: Registry,
  device: DeviceInfo,
  params: TvRemoteParams,
  unsupported?: ReadonlySet<RemoteButton>
): Promise<TvRemoteResult> {
  const buttons = expandButtons(params.button, params.repeat);

  if (unsupported?.size) {
    const bad = [...new Set(buttons.filter((b) => unsupported.has(b)))];
    if (bad.length) {
      throw new UnsupportedOperationError(
        "tv-remote",
        device,
        `${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not supported on the Apple TV ` +
          `simulator (its HID stack ignores media-transport / volume keys) — use up/down/left/` +
          `right/select/back/menu/home/playPause, or drive media via the app's on-screen controls`
      );
    }
  }

  const api = await resolveTvApi(registry, device.id);
  const pressed: RemoteButton[] = [];
  for (const button of buttons) {
    await api.navigate(button);
    pressed.push(button);
  }
  return { pressed, count: pressed.length };
}
