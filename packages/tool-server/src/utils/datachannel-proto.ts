/**
 * Encoders for the `datachannel.DataChannelCommand` messages simulator-server
 * reads off the MoQ control track.
 *
 * These now live in `@swmansion/argent-cloud-sdk`, alongside the canonical `.proto`
 * and a test that checks the encoder against it, so argent and the radon-cloud
 * webui can no longer drift apart. Re-exported here so the existing import
 * sites keep working.
 */

export {
  encodeButton,
  encodeKey,
  encodeRotate,
  encodeScreenshot,
  encodeTouch,
  encodeWheel,
} from "@swmansion/argent-cloud-sdk";

export type {
  ButtonName,
  KeyActionName,
  RotationName,
  TouchActionName,
} from "@swmansion/argent-cloud-sdk";
