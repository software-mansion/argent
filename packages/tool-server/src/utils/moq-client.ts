/**
 * Pure-JS MoQ client used by the remote simulator-server blueprint.
 *
 * Talks to the simulator-server's MoQ relay (URL + self-signed cert
 * fingerprint surfaced by `sim-remote moq-info`). Subscribes to the
 * server-published "simulator" broadcast (catalog/video/screenshot tracks)
 * and publishes its own broadcast carrying a "control" track that the
 * server subscribes to for protobuf-encoded DataChannelCommand input
 * (touch / key / button / rotate / wheel / screenshot).
 *
 * WebTransport in Node is supplied by `@fails-components/webtransport`,
 * which is polyfilled onto `globalThis` lazily on first use.
 */

import * as Moq from "@moq/net";
import { encodeScreenshot } from "./datachannel-proto";
import { moqInfo, type MoqInfo } from "./sim-remote";

let polyfillReady: Promise<void> | null = null;

async function ensurePolyfill(): Promise<void> {
  if (polyfillReady) return polyfillReady;
  polyfillReady = (async () => {
    const g = globalThis as Record<string, unknown>;
    if (typeof g.WebSocket === "undefined") {
      const ws = await import("ws");
      g.WebSocket = ws.default;
    }
    if (typeof g.WebTransport === "undefined") {
      const wt = await import("@fails-components/webtransport");
      g.WebTransport = wt.WebTransport;
      // quicheLoaded is a one-shot promise that resolves once the bundled
      // libquiche binding finishes loading; awaiting it once is enough.
      await wt.quicheLoaded;
    }
  })();
  return polyfillReady;
}

/**
 * `@moq/net`'s `connect()` races WebTransport + WebSocket via `Promise.any`,
 * which wraps the underlying errors in an `AggregateError` whose `.message`
 * is the generic "All promises were rejected". Surface the actual failure
 * (cert pin mismatch, handshake timeout, missing polyfill, etc.) so the
 * agent sees what went wrong instead of a useless aggregate.
 */
function unwrapMoqConnectError(err: unknown, url: string): Error {
  if (err instanceof AggregateError) {
    const parts = err.errors.map((e) =>
      e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    );
    return new Error(`MoQ connect to ${url} failed: ${parts.join(" | ")}`);
  }
  if (err instanceof Error) {
    return new Error(`MoQ connect to ${url} failed: ${err.message}`);
  }
  return new Error(`MoQ connect to ${url} failed: ${String(err)}`);
}

function decodeHexFingerprint(fingerprint: string): Uint8Array {
  // Accept "AA:BB:CC..." or "aabbcc..." styles — strip separators, lowercase.
  const cleaned = fingerprint.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Invalid MoQ certificate fingerprint (odd hex length): ${fingerprint}`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface MoqClient {
  /** Send one protobuf-encoded DataChannelCommand frame. Awaits the initial control-track subscription on first call. */
  sendControl(payload: Uint8Array): Promise<void>;
  /** Request one screenshot and return the decoded PNG/JPEG bytes. Concurrent calls serialise. */
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
  await ensurePolyfill();
  const info: MoqInfo = await moqInfo(udid);
  return openMoqClientFromInfo(info);
}

export async function openMoqClientFromInfo(info: MoqInfo): Promise<MoqClient> {
  await ensurePolyfill();
  const url = new URL(info.url);
  // sim-server rejects MoQ sessions without the lease token; the relay
  // forwards it end-to-end from the `?token=` query param.
  if (info.token) url.searchParams.set("token", info.token);
  const fingerprint = decodeHexFingerprint(info.fingerprint);

  let established;
  try {
    established = await Moq.Connection.connect(url, {
      webtransport: {
        serverCertificateHashes: [{ algorithm: "sha-256", value: fingerprint }],
      },
      // WebSocket fallback is pointless against simulator-server (QUIC-only),
      // and the default 500ms head-start delay would cost us latency on every
      // reconnect. Disable the race.
      websocket: { enabled: false },
    });
  } catch (err) {
    throw unwrapMoqConnectError(err, info.url);
  }

  // --- Server-published "simulator" broadcast (catalog/video/screenshot) ---
  const simulator = established.consume(Moq.Path.from("simulator"));
  const screenshotTrack = simulator.subscribe("screenshot", 0);

  // --- Client-published "argent" broadcast (control) ---
  const controlBroadcast = new Moq.Broadcast();
  established.publish(Moq.Path.from("argent"), controlBroadcast);

  // The server subscribes to our "control" track when it picks up the
  // announcement. Cache the requested Track so subsequent sendControl calls
  // don't re-await — the first call may have to wait, the rest are O(1).
  let controlTrackPromise: Promise<import("@moq/net").Track> | null = null;
  const getControlTrack = (): Promise<import("@moq/net").Track> => {
    if (controlTrackPromise) return controlTrackPromise;
    controlTrackPromise = (async () => {
      // Filter out non-"control" track requests in case the server requests
      // anything else in the future.
      for (;;) {
        const req = await controlBroadcast.requested();
        if (!req) {
          throw new Error("MoQ control broadcast closed before server subscribed");
        }
        if (req.track.name === "control") return req.track;
      }
    })();
    return controlTrackPromise;
  };

  // Screenshots: serialise concurrent callers so they don't race for the
  // next frame on the shared screenshot track (server has no per-request id).
  let screenshotChain: Promise<unknown> = Promise.resolve();
  let screenshotSeq = 0;

  const api: MoqClient = {
    async sendControl(payload: Uint8Array): Promise<void> {
      const track = await getControlTrack();
      track.writeFrame(payload);
    },

    async screenshot(opts?: { scale?: number }): Promise<Buffer> {
      const run = async (): Promise<Buffer> => {
        const id = String(++screenshotSeq);
        const cmd = encodeScreenshot({ id, scale: opts?.scale });
        const track = await getControlTrack();
        track.writeFrame(cmd);
        const frame = await screenshotTrack.readFrame();
        if (!frame) {
          throw new Error("MoQ screenshot track closed before frame arrived");
        }
        // Server frames the screenshot as `{"data":"<base64>"}`.
        const json = JSON.parse(new TextDecoder().decode(frame)) as { data?: string };
        if (typeof json.data !== "string") {
          throw new Error(`MoQ screenshot frame missing 'data' field: ${JSON.stringify(json)}`);
        }
        return Buffer.from(json.data, "base64");
      };
      const result = screenshotChain.then(run, run);
      // Keep the chain advancing regardless of individual failures.
      screenshotChain = result.catch(() => undefined);
      return result;
    },

    async close(): Promise<void> {
      try {
        controlBroadcast.close();
      } catch {
        // Best-effort close — already-closed transports are not an error here.
      }
      try {
        established.close();
      } catch {
        // Best-effort close — already-closed transports are not an error here.
      }
    },
  };

  return api;
}
