import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { ALL_BUTTONS, type ButtonParams, type ButtonResult } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { makeAndroidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or TV target)."),
  button: z
    .enum(ALL_BUTTONS)
    .describe(
      "Button to press. Phone/tablet hardware buttons: home, back, power, volumeUp, volumeDown, " +
        "appSwitch, actionButton. TV remote buttons (runtimeKind 'tv' targets): up, down, left, " +
        "right (move the focus highlight), select (activate the focused element), menu (back), " +
        "home (exit to the TV home screen), playpause (toggle media). Buttons not valid for the " +
        "target are rejected with a clear error."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

// `button` goes through `dispatchByPlatform`. TV is not a `platform` (a tvOS sim
// classifies as "ios" and an Android TV emulator as "android" by id shape), it's
// a `runtimeKind` spanning both — so each platform branch runtime-probes its own
// TV kind and routes a remote press to the shared tv-control backend, otherwise
// sends the hardware button (see platforms/{ios,android,tv}.ts). No service is
// declared eagerly: distinguishing a TV target is async, and declaring
// simulator-server up front would also spawn it for a tvOS udid it can't drive.
export function createButtonTool(registry: Registry): ToolDefinition<Params, ButtonResult> {
  return {
    id: "button",
    description: `Press a device button — a phone/tablet hardware button (iOS simulator / Android emulator) or a TV remote button (Apple TV / Android TV). Sends Down then Up automatically.
Phone/tablet hardware buttons: home, back, power, volumeUp, volumeDown, appSwitch, actionButton — buttons not present on the target platform (e.g. 'back' on iOS, 'actionButton' on Android) are rejected with a clear error.
On a TV target (runtimeKind 'tv') this is how you drive the remote: up/down/left/right move the focus highlight, select activates the focused element, menu goes back, home exits to the TV home screen, playpause toggles media. Call \`describe\` afterwards to see where focus landed. TV buttons are rejected on a phone/tablet and vice versa.
Returns { pressed: buttonName }.
Fails if the simulator-server / emulator backend (phone/tablet) or the TV control daemons are not reachable for the given device.`,
    zodSchema,
    capability,
    searchHint:
      "hardware button home back power volume app switch tv remote dpad up down left right select menu play pause siri leanback",
    // No eager service: each branch resolves its backend lazily (TV control vs
    // simulator-server), since distinguishing a TV target is async and a tvOS
    // udid must never resolve simulator-server.
    services: () => ({}),
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      ButtonParams,
      ButtonResult
    >({
      toolId: "button",
      capability,
      ios: makeIosImpl(registry),
      android: makeAndroidImpl(registry),
    }),
  };
}
