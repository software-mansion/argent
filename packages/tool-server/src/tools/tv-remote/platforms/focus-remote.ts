import type { DeviceInfo, InvokeToolOptions, Registry } from "@argent/registry";
import { resolveTvApi } from "../../tv/tv-service";
import { UnsupportedOperationError } from "../../../utils/capability";
import type { RemoteButton } from "../../../utils/vega-input";
import { expandButtons, type TvRemoteParams, type TvRemoteResult } from "../types";

// Shared Apple TV / Android TV remote path: both back onto `TvControlApi`, whose
// `navigate` takes the full `RemoteButton` vocabulary. One press per daemon /
// `adb` round-trip — there is no batched path like Vega's `inputd-cli`.
//
// `unsupported` rejects buttons a backend can't honor before any press fires, so
// a path can't half-execute.
export async function pressFocusRemote(
  registry: Registry,
  device: DeviceInfo,
  params: TvRemoteParams,
  unsupported?: ReadonlySet<RemoteButton>,
  options?: InvokeToolOptions
): Promise<TvRemoteResult> {
  const buttons = expandButtons(params.button, params.repeat);

  // Resolve first: this rejects a non-TV target, so the check below can't tell an
  // iPhone it's "not supported on the Apple TV simulator".
  const api = await resolveTvApi(registry, device.id);

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

  const pressed: RemoteButton[] = [];
  // Up to 64 buttons × repeat 50 means the loop can run for minutes, and
  // `longRunning` disables the MCP fetch timeout, so nothing else stops it: bail
  // between presses once the caller cancels. Sent presses can't be rolled back,
  // and throwing beats returning a partial tally no caller is waiting for.
  for (const button of buttons) {
    options?.signal?.throwIfAborted();
    await api.navigate(button);
    pressed.push(button);
  }
  return { pressed, count: pressed.length };
}
