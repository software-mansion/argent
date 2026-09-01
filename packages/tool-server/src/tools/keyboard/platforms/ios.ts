import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { getSimulatorRuntimeKind } from "../../../utils/ios-devices";
import { getRemoteSimulatorRuntimeKind } from "../../../utils/sim-remote";
import { CLEAR_KEY_PAIRS } from "../key-codes";
import type { KeyboardParams, KeyboardResult } from "../types";
import { clearSimulatorServer, typeSimulatorServer } from "../simulator-server-keys";
import { typeTv } from "./tv";

// `text`, `key` and `clear` are at-most-one (rejected in ../index.ts), so the
// branch here is a routing choice, not an ordering one. Shared by the simulator
// and ios-remote impls: both drive the same `pressKey` transport (MoQ for the
// remote one), so a clear that only reached one of them would be a silent
// platform gap.
function runSimulatorServer(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  return params.clear === true
    ? clearSimulatorServer(registry, device, signal)
    : typeSimulatorServer(registry, device, params);
}

// The runtime kind is read as three-valued, and an unknown one refuses the
// clear. Both sources collapse "could not tell" onto "not a TV" if asked for a
// boolean: `getSimulatorRuntimeKind` answers undefined for a UDID that is not in
// the listing, and `listIosSimulators` returns [] on ANY failure of
// `xcrun simctl list devices --json`, its own 10s timeout included. Nothing
// caches a failed probe, so every call was exposed.
//
// This is the reasoning platforms/android.ts already applies to the same
// operation. On the fail-open path the 400-event burst was aimed at a tvOS UDID
// — the one thing platforms/tv.ts exists to refuse — and the caller was told
// `{ keys: 200, cleared: true }` for a device where nothing was cleared, so the
// next step types into a field the agent believes is empty. Reproduced against a
// booted Apple TV simulator by filtering it out of the listing, which is the
// answer a timed-out probe also produces: simulator-server was spawned at the
// tvOS UDID and 400 HID delete events were written at it.
//
// `clear` only. A plain `key` press is equally unguarded here, but that half
// predates this backend's clear and is unchanged by it — what is new is a
// 200-key burst riding a `cleared: true` success claim.
function refuseUnknownKind(udid: string, probe: string): FailureError {
  return new FailureError(
    `whether ${udid} is an iPhone/iPad simulator or an Apple TV one could not be determined, and ` +
      "`clear` means different things on the two — nothing was sent. It is refused rather than " +
      `guessed: on a TV this would have burst ${CLEAR_KEY_PAIRS * 2} delete keys at the focus ` +
      `engine, which no backend can drive. The probe reads \`${probe}\`; a listing that misses its ` +
      "10s budget under host load, or does not carry this UDID, answers neither. Check " +
      "`list-devices` reports the simulator as available and retry — or, if it IS an Apple TV, " +
      "empty the field with the app's on-screen keyboard, driven with `tv-remote`.",
    {
      error_code: FAILURE_CODES.KEYBOARD_TARGET_KIND_UNKNOWN,
      failure_stage: "keyboard_ios_runtime_kind",
      failure_area: "tool_server",
      // Not "timeout": a listing that came back without this UDID answers the
      // same undefined, and no probe timed out there. What both causes share is
      // that the device is not in the listing.
      error_kind: "not_found",
      failure_command: "xcrun_simctl",
    }
  );
}

// A tvOS sim is `platform: "ios"` by UDID shape; the TV/mobile split lives in
// `runtimeKind`, which only an async runtime probe can resolve.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) => {
      const kind = await getSimulatorRuntimeKind(device.id);
      if (kind === "tv") return typeTv(registry, device, params);
      if (kind === undefined && params.clear === true) {
        throw refuseUnknownKind(device.id, "xcrun simctl list devices --json");
      }
      return runSimulatorServer(registry, device, params, options?.signal);
    },
  };
}

// A remote tvOS sim is `platform: "ios-remote"` by UDID shape too, exactly as a
// local one is `"ios"`, so without a probe here a remote Apple TV took the
// 400-event clear burst — the one thing `platforms/tv.ts` documents as
// unsupported on a TV — and a named key it also rejects.
//
// Narrower than `makeIosImpl`'s branch on purpose: only `key` and `clear` are
// routed to `typeTv`, which refuses both before resolving anything. `text`
// keeps the MoQ HID path it already had, rather than being moved onto the TV
// daemon's channel by a fix aimed at the burst. The probe therefore runs only
// for the two shapes that need it.
export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) => {
      if (params.key !== undefined || params.clear === true) {
        const kind = await getRemoteSimulatorRuntimeKind(device.id);
        if (kind === "tv") return typeTv(registry, device, params);
        if (kind === undefined && params.clear === true) {
          throw refuseUnknownKind(device.id, "sim-remote simctl list devices --json");
        }
      }
      return runSimulatorServer(registry, device, params, options?.signal);
    },
  };
}
