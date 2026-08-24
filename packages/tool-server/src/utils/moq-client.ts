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
