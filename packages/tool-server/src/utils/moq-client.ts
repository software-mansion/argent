/**
 * MoQ client for the remote simulator-server blueprint. The protocol itself
 * lives in `@swmansion/argent-cloud-sdk`; this module only adds the
 * argent-specific pieces — endpoint resolution via `sim-remote moq-info`, the
 * Node WebTransport polyfill, and `Buffer` screenshots.
 */

import { MoqDeviceSession, connectMoq, type KeyActionName } from "@swmansion/argent-cloud-sdk";
import { installNodeWebTransport } from "@swmansion/argent-cloud-sdk/node";
import { moqInfo, type MoqInfo } from "./sim-remote";

const PUBLISH_PATH = "argent";

export interface MoqClient {
  sendControl(payload: Uint8Array): Promise<void>;
  /** Ordered "keys" track; the latest-wins control track drops reordered Down/Up pairs. */
  key(action: KeyActionName, code: number): Promise<void>;
  screenshot(opts?: { scale?: number }): Promise<Buffer>;
  close(): Promise<void>;
}

export async function openMoqClient(udid: string): Promise<MoqClient> {
  return openMoqClientFromInfo(await moqInfo(udid));
}

async function openMoqClientFromInfo(info: MoqInfo): Promise<MoqClient> {
  await installNodeWebTransport();
  const session = new MoqDeviceSession(await connectMoq(info), { publishPath: PUBLISH_PATH });
  let closed = false;
  disposeWhenTransportDies(session, () => (closed = true));

  // The SDK resolves sends on a closed session, reporting undelivered input as sent.
  const refuseClosed = (send: () => Promise<void>) =>
    closed ? Promise.reject(new Error("MoQ session is closed")) : send();

  return {
    sendControl: (payload) => refuseClosed(() => session.sendControl(payload)),
    key: (action, code) => refuseClosed(() => session.key(action, code)),
    async screenshot(opts) {
      return Buffer.from(await session.screenshot({ scale: opts?.scale }));
    },
    async close() {
      closed = true;
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
 * path instead: `screenshot` then rejects before it opens any stream. Sends get
 * no such guard from the SDK, so `onDispose` lets the client refuse them.
 */
function disposeWhenTransportDies(session: MoqDeviceSession, onDispose: () => void): void {
  const dispose = () => {
    onDispose();
    try {
      session.close();
    } catch {
      // Tearing down a transport that is already gone. Nothing left to close.
    }
  };
  // Both arms: `closed` rejects when the transport failed rather than ended.
  void session.closed.then(dispose, dispose);
}
