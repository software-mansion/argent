import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { getSimulatorRuntimeKind } from "../../../utils/ios-devices";
import { getRemoteSimulatorRuntimeKind } from "../../../utils/sim-remote";
import { InvalidToolInputError } from "../../../utils/capability";
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
// A clear now works on BOTH kinds, but not over the same transport: an iPhone
// takes the burst over simulator-server's HID channel, an Apple TV over the
// injected tvOS HID daemon (blueprints/tv-control.ts). Guessing wrong is
// therefore still silent corruption rather than a slow path — reproduced
// against a booted Apple TV simulator by filtering it out of the listing, which
// is the answer a timed-out probe also produces: simulator-server was spawned at
// the tvOS UDID and 400 HID delete events were written at it, with the caller
// told `{ keys: 200, cleared: true }` for a field nothing had touched, so the
// next step types into a field the agent believes is empty.
//
// This is the reasoning platforms/android.ts used to apply to the same
// operation, and no longer needs to: there BOTH kinds clear through one
// `adb shell input keyevent`, so the answer stops changing what is sent.
//
// `clear` only. A plain `key` press is equally unguarded here, but that half
// predates this backend's clear and is unchanged by it — what is new is a
// 200-key burst riding a `cleared: true` success claim.
function refuseUnknownKind(udid: string, probe: string, remote: boolean): FailureError {
  return new FailureError(
    `whether ${udid} is an iPhone/iPad simulator or an Apple TV one could not be determined, and ` +
      "`clear` reaches the two over different transports — nothing was sent. It is refused rather " +
      `than guessed: the ${CLEAR_KEY_PAIRS * 2} delete keys would have gone to simulator-server, ` +
      "which an Apple TV UDID does not answer, and the call would still have reported the field " +
      `cleared. The probe reads \`${probe}\`; a listing that misses its ` +
      "10s budget under host load, or does not carry this UDID, answers neither. Check " +
      "`list-devices` reports the simulator as available and retry — " +
      // Templated, because the two impls share this message and only one of them
      // can promise a clear once the kind is known: a REMOTE Apple TV refuses it
      // outright (see `makeIosRemoteImpl`), so telling that caller it "works on
      // either kind" sends them into a second failure.
      (remote
        ? "an iPhone/iPad then clears; a remote Apple TV does not support `clear` at all."
        : "the clear then works on either kind."),
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
      if (kind === "tv") return typeTv(registry, device, params, options?.signal);
      if (kind === undefined && params.clear === true) {
        throw refuseUnknownKind(device.id, "xcrun simctl list devices --json", false);
      }
      return runSimulatorServer(registry, device, params, options?.signal);
    },
  };
}

// A remote tvOS sim is `platform: "ios-remote"` by UDID shape too, exactly as a
// local one is `"ios"`, so without a probe here a remote Apple TV took the
// 400-event simulator-server burst meant for an iPhone, and a named key
// `platforms/tv.ts` rejects.
//
// Narrower than `makeIosImpl`'s branch on purpose: only `key` and `clear` are
// routed past the probe. `text` keeps the MoQ HID path it already had, rather
// than being moved onto the TV daemon's channel by a fix aimed at the burst. The
// probe therefore runs only for the two shapes that need it.
export function makeIosRemoteImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) => {
      if (params.key !== undefined || params.clear === true) {
        const kind = await getRemoteSimulatorRuntimeKind(device.id);
        if (kind === "tv") {
          // Nothing in argent drives a REMOTE Apple TV, so both shapes that
          // reach this branch are refused — `text` never enters it and keeps the
          // MoQ HID path below.
          //
          // Not a `typeTv` call: that backend resolves the tvOS control service,
          // whose factory looks the target up in the HOST's
          // `xcrun simctl list devices` and whose daemons are host processes
          // holding a `SimDeviceLegacyClient` against a LOCAL CoreSimulator
          // device. A sim-remote UDID is in neither, so delegating would answer
          // a 500 reading "no available simulator with udid '<id>'" for a device
          // `list-devices` does report. The rest of the TV surface draws the same
          // line: `describe`'s ios-remote branch never probes for tvOS, and
          // `tv-remote` does not declare `appleRemote` at all.
          //
          // One message for both, because that last fact makes the LOCAL
          // refusals' remedies wrong here: "move focus with `tv-remote`" names a
          // tool this device cannot use either.
          // NOT `UnsupportedOperationError`: that class renders as "Tool
          // 'keyboard' is not supported on ios-remote simulator", which is
          // false — `keyboard { text }` on this very device falls through to
          // the MoQ path below. It also left this the one clear refusal outside
          // the `KEYBOARD_CLEAR_*` telemetry buckets. `InvalidToolInputError`
          // keeps the 400 (http.ts maps it by class, as it does the other one)
          // while carrying the granular code, which is the pattern
          // ../simulator-server-keys.ts already uses.
          throw new InvalidToolInputError(
            "`key` and `clear` are not supported on a REMOTE Apple TV — nothing was pressed or " +
              "cleared. `text` still types on this device; those two need the tvOS daemons, " +
              "which drive a simulator in this host's own CoreSimulator set and cannot " +
              "reach one behind sim-remote. `tv-remote` cannot reach it either, so there is no " +
              "focus-driven fallback on this device: run against a LOCAL Apple TV simulator, or " +
              "empty and fill the field with the app's own on-screen keyboard.",
            {
              error_code:
                params.clear === true
                  ? FAILURE_CODES.KEYBOARD_CLEAR_UNSUPPORTED_TARGET
                  : FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
              failure_stage: "keyboard_ios_remote_tv",
              error_kind: "unsupported",
            }
          );
        }
        if (kind === undefined && params.clear === true) {
          throw refuseUnknownKind(device.id, "sim-remote simctl list devices --json", true);
        }
      }
      return runSimulatorServer(registry, device, params, options?.signal);
    },
  };
}
