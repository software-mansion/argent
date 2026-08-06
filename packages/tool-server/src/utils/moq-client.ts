/**
 * MoQ client used by the remote simulator-server blueprint.
 *
 * The protocol lives in `@swmansion/argent-cloud-sdk`, shared with the other
 * clients of the same backend; this module only supplies the pieces specific to
 * argent — resolving the endpoint through `sim-remote moq-info`, installing the
 * Node WebTransport polyfill, and handing screenshots back as `Buffer`.
 */

import { MoqDeviceSession, connectMoq } from "@swmansion/argent-cloud-sdk";
import { installNodeWebTransport } from "@swmansion/argent-cloud-sdk/node";
import { moqInfo, type MoqInfo } from "./sim-remote";

/**
 * Broadcast path argent publishes its control track on. The server subscribes
 * to the "control" track of any announced broadcast, so this is just a label.
 */
const PUBLISH_PATH = "argent";

export interface MoqClient {
  /** Send one protobuf-encoded DataChannelCommand frame. Awaits the initial control-track subscription on first call. */
  sendControl(payload: Uint8Array): Promise<void>;
  /** Request one screenshot and return the decoded PNG/JPEG bytes. */
  screenshot(opts?: { scale?: number }): Promise<Buffer>;
  /** Tear down the underlying WebTransport session and any in-flight subscriptions. */
  close(): Promise<void>;
}

/**
 * Open a MoQ session to the simulator-server backing the given remote udid.
 * Resolves once the WebTransport handshake completes and the local control
 * broadcast is published; the control track itself is awaited lazily on the
 * first sendControl call.
 */
export async function openMoqClient(udid: string): Promise<MoqClient> {
  return openMoqClientFromInfo(await moqInfo(udid));
}

export async function openMoqClientFromInfo(info: MoqInfo): Promise<MoqClient> {
  await installNodeWebTransport();
  const session = new MoqDeviceSession(await connectMoq(info), { publishPath: PUBLISH_PATH });

  return {
    sendControl: (payload) => session.sendControl(payload),
    async screenshot(opts) {
      return Buffer.from(await session.screenshot({ scale: opts?.scale }));
    },
    async close() {
      session.close();
    },
  };
}
