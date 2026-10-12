/**
 * MoQ client for the remote simulator-server blueprint. The protocol itself
 * lives in `@swmansion/argent-cloud-sdk`; this module only adds the
 * argent-specific pieces — endpoint resolution via `sim-remote moq-info`, the
 * Node WebTransport polyfill, and `Buffer` screenshots.
 */

import { MoqDeviceSession, connectMoq } from "@swmansion/argent-cloud-sdk";
import { installNodeWebTransport } from "@swmansion/argent-cloud-sdk/node";
import { moqInfo, type MoqInfo } from "./sim-remote";

const PUBLISH_PATH = "argent";

export interface MoqClient {
  sendControl(payload: Uint8Array): Promise<void>;
  screenshot(opts?: { scale?: number }): Promise<Buffer>;
  close(): Promise<void>;
}

export async function openMoqClient(udid: string): Promise<MoqClient> {
  return openMoqClientFromInfo(await moqInfo(udid));
}

async function openMoqClientFromInfo(info: MoqInfo): Promise<MoqClient> {
  await installNodeWebTransport();
  const session = new MoqDeviceSession(await connectMoq(info), { publishPath: PUBLISH_PATH });
  disposeWhenTransportDies(session);

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

/**
 * A cloud transport can die under a session nobody closed - the machine is
 * released, the network drops - and the SDK does not mark the session disposed
 * for it. Its first screenshot after that subscribes a track on a dead
 * WebTransport, and `@moq/net` runs that subscribe detached (`void
 * #runSubscribe`), so the `InvalidStateError` it throws lands as an unhandled
 * rejection no caller can catch. `index.ts` treats one of those as fatal, so
 * asking a released machine for a screenshot killed the tool server.
 *
 * Closing the session when its transport closes takes the SDK's own guarded
 * path instead: `screenshot` then rejects before it opens any stream. Sends are
 * unaffected - they reuse the control track resolved at connect and keep
 * failing with `track is closed`.
 */
function disposeWhenTransportDies(session: MoqDeviceSession): void {
  const dispose = () => {
    try {
      session.close();
    } catch {
      // Tearing down a transport that is already gone. Nothing left to close.
    }
  };
  // Both arms: `closed` rejects when the transport failed rather than ended.
  void session.closed.then(dispose, dispose);
}
