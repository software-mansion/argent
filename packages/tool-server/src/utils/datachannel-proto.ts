/**
 * Encoders for the `datachannel.DataChannelCommand` messages simulator-server
 * reads off the MoQ control track.
 *
 * These now live in `@swmansion/argent-cloud-sdk`, alongside the canonical
 * `.proto` and a test that checks the encoder against it, so the clients of this
 * protocol can no longer drift apart. Re-exported here so the existing import
 * sites keep working.
 *
 * This package deliberately keeps no copy of the schema. To read it, see
 * `@swmansion/argent-cloud-sdk/proto/datachannel.proto`, which the package
 * ships; a vendored copy here would only be one more thing to fall behind the
 * server.
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
