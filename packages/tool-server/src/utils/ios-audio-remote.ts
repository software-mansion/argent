import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { FAILURE_CODES, FailureError, type FailureCode } from "@argent/registry";
import { audioDylibPathTcp, audioFeederPathTcp } from "@argent/native-devtools-ios";
import { stripRemotePrefix } from "./device-info";
import { audioDir, parseUIKitApplicationJobs } from "./ios-host";
import { decideHookState, parseAppStatus, type AppAudioStatus, type HookState } from "./ios-audio";
import { STREAM_RATE } from "./ios-audio-rings";
import { InvalidToolInputError } from "./capability";
import { injectDylib, proxyStart, proxyStop, setSimulatorEnv, simctlSpawn } from "./sim-remote";

/**
 * The audio mock on an Argent Cloud simulator. The hook in the app talks to its control directory on the Mac that
 * runs the simulator, which this process cannot reach, so a small helper (`argent-audio-feeder`, built for the
 * simulator) runs inside the remote simulator and does what `ios-audio.ts` and `InputFeeder` do locally: it keeps
 * the in ring topped up and writes the `input` file. It connects back to this process through a `sim-remote`
 * reverse tunnel and takes one command at a time:
 *
 *   TONE <hz> <amplitude>         FILE <plays> <bytes> + the original audio file, decoded in the simulator
 *   MIC                           STATUS -> the `st.<bundleId>` files with whether their pid is alive
 *
 * When the connection drops (tool-server exit, dispose) the helper removes the input it wrote and exits, which gives
 * the apps their microphone back.
 */

const AUDIO_DIR_ENV = "ARGENT_AUDIO_DIR";
const AUDIO_DYLIB = "libArgentAudio.dylib";
const CONNECT_TIMEOUT_MS = 30_000;
const REPLY_TIMEOUT_MS = 60_000;
/** The original file crosses the tunnel; the feeder caps the decoded clip at 10 minutes. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** One remote simulator's link to its feeder. */
export interface RemoteAudioSession {
  readonly udid: string;
  /** Control directory on the remote Mac. */
  readonly dir: string;
  link: FeederLink | null;
  /** This process uploaded its own hook: one another Argent version left on the remote Mac may differ. */
  hookUploaded: boolean;
}

export function createRemoteAudioSession(udid: string): RemoteAudioSession {
  return { udid, dir: audioDir(stripRemotePrefix(udid)), link: null, hookUploaded: false };
}

function failure(
  message: string,
  stage: string,
  code: FailureCode = FAILURE_CODES.AUDIO_ENV_SETUP_FAILED
) {
  return new FailureError(message, {
    error_code: code,
    failure_stage: stage,
    failure_area: "tool_server",
    error_kind: "subprocess",
  });
}

/** Line and byte reader over the feeder's socket, one command in flight at a time. */
class FeederLink {
  private buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  closed = false;

  constructor(
    private readonly socket: net.Socket,
    private readonly server: net.Server,
    private readonly udid: string,
    private readonly port: number
  ) {
    socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake?.();
    });
    const onClose = () => {
      this.closed = true;
      this.wake?.();
    };
    socket.on("close", onClose);
    socket.on("error", onClose);
    socket.resume(); // paused while the HELLO handshake handed it over
  }

  private async waitFor<T>(take: () => T | null, deadline: number): Promise<T> {
    for (;;) {
      const got = take();
      if (got !== null) return got;
      if (this.closed) throw failure("The remote audio feeder disconnected.", "audio_remote_link");
      const left = deadline - Date.now();
      if (left <= 0) throw failure("The remote audio feeder did not answer.", "audio_remote_link");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  readLine(deadline: number): Promise<string> {
    return this.waitFor(() => {
      const nl = this.buf.indexOf(10);
      if (nl < 0) return null;
      const line = this.buf.subarray(0, nl).toString("utf8");
      this.buf = this.buf.subarray(nl + 1);
      return line;
    }, deadline);
  }

  readBytes(n: number, deadline: number): Promise<Buffer> {
    return this.waitFor(() => {
      if (this.buf.length < n) return null;
      const out = Buffer.from(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
      return out;
    }, deadline);
  }

  /** Sends one command and returns the text after `OK`; `then` reads any records that follow the reply. */
  request<T = string>(
    line: string,
    payload?: Buffer,
    then?: (rest: string, deadline: number) => Promise<T>,
    refusedCode: FailureCode = FAILURE_CODES.AUDIO_ENV_SETUP_FAILED
  ): Promise<T> {
    const run = async () => {
      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      this.socket.write(line + "\n");
      if (payload) this.socket.write(payload);
      let reply: string;
      try {
        reply = await this.readLine(deadline);
      } catch (err) {
        // A reply that comes after the timeout would answer the next command: drop the link instead. The feeder
        // sees the disconnect and exits; the next call starts a new one.
        this.drop();
        throw err;
      }
      if (!reply.startsWith("OK")) {
        throw failure(
          `The remote audio feeder refused ${line.split(" ")[0]}: ${reply}`,
          "audio_remote_link",
          refusedCode
        );
      }
      const rest = reply.slice(2).trim();
      if (!then) return rest as T;
      try {
        return await then(rest, deadline);
      } catch (err) {
        this.drop();
        throw err;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  private drop(): void {
    this.closed = true;
    this.socket.destroy();
  }

  async close(): Promise<void> {
    this.drop();
    this.server.close();
    await proxyStop(this.udid, this.port);
  }
}

async function remoteGetenv(udid: string, name: string): Promise<string> {
  const { stdout } = await simctlSpawn(udid, { args: ["launchctl", "getenv", name] }).catch(() => ({
    stdout: "",
  }));
  return stdout.trim();
}

/**
 * Inserts the audio hook into the remote simulator's launchd environment and points it at the control directory.
 * Checked on every call: a reboot wipes both. The first call of this process uploads its hook even when one is
 * inserted, since an older Argent may have left its own. Apps launched from now on carry the hook.
 */
export async function armRemoteAudio(session: RemoteAudioSession): Promise<void> {
  const { udid, dir } = session;
  const [inserted, current] = await Promise.all([
    remoteGetenv(udid, "DYLD_INSERT_LIBRARIES"),
    remoteGetenv(udid, AUDIO_DIR_ENV),
  ]);
  try {
    if (
      !session.hookUploaded ||
      !inserted.split(":").some((p) => path.basename(p) === AUDIO_DYLIB)
    ) {
      await injectDylib(udid, { filePath: audioDylibPathTcp(), insert: true });
      session.hookUploaded = true;
    }
    if (current !== dir) await setSimulatorEnv(udid, AUDIO_DIR_ENV, dir);
  } catch (err) {
    throw failure(
      `Could not add the audio hook to ${udid}: ${(err as Error).message}`,
      "audio_env_setup"
    );
  }
}

/** The feeder link, starting the feeder in the remote simulator when none is connected. */
async function ensureLink(session: RemoteAudioSession): Promise<FeederLink> {
  if (session.link && !session.link.closed) return session.link;
  session.link = null;
  const token = randomBytes(12).toString("hex");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  let timer: NodeJS.Timeout | undefined;
  const connected = new Promise<net.Socket>((resolve, reject) => {
    timer = setTimeout(
      () => reject(failure("The remote audio feeder did not connect.", "audio_remote_link")),
      CONNECT_TIMEOUT_MS
    );
    server.on("connection", (socket) => {
      let hello = "";
      const onData = (chunk: Buffer) => {
        hello += chunk.toString("utf8");
        const nl = hello.indexOf("\n");
        if (nl < 0) return;
        socket.off("data", onData);
        if (hello.slice(0, nl).split(" ")[1] !== token) {
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        // Paused until FeederLink listens, so nothing after the HELLO is lost in between.
        socket.pause();
        const rest = Buffer.from(hello.slice(nl + 1), "utf8");
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      };
      socket.on("data", onData);
    });
  });
  // Awaited only once the feeder is spawned: a failed spawn must not leave the timeout to reject unobserved.
  connected.catch(() => {});
  try {
    await proxyStart(session.udid, port);
    await simctlSpawn(session.udid, {
      binPath: audioFeederPathTcp(),
      args: [session.dir, String(port), token],
      detach: true,
    });
    const socket = await connected;
    socket.setNoDelay(true);
    session.link = new FeederLink(socket, server, session.udid, port);
    return session.link;
  } catch (err) {
    clearTimeout(timer);
    server.close();
    await proxyStop(session.udid, port);
    if (err instanceof FailureError) throw err;
    throw failure(
      `Could not start the audio feeder in ${session.udid}: ${(err as Error).message}`,
      "audio_remote_link"
    );
  }
}

type RemoteAudioSource =
  | { kind: "file"; path: string; plays: number }
  | { kind: "tone"; frequencyHz: number; amplitude: number };

export async function setRemoteAudioInput(
  session: RemoteAudioSession,
  source: RemoteAudioSource
): Promise<{ source: "file" | "tone"; durationMs?: number }> {
  if (source.kind === "tone") {
    const link = await ensureLink(session);
    await link.request(`TONE ${source.frequencyHz} ${source.amplitude}`);
    return { source: "tone" };
  }
  // Sent as is and decoded in the simulator (AudioToolbox), so a tool-server without afconvert (Linux) can play files.
  let bytes: Buffer;
  try {
    if (fs.statSync(source.path).size > MAX_FILE_BYTES) {
      throw new InvalidToolInputError(
        `${source.path} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`
      );
    }
    bytes = fs.readFileSync(source.path);
  } catch (err) {
    if (err instanceof InvalidToolInputError) throw err;
    throw new InvalidToolInputError(`Audio file not found: ${source.path}`);
  }
  const link = await ensureLink(session);
  const frames = Number(
    await link.request(
      `FILE ${source.plays} ${bytes.length}`,
      bytes,
      undefined,
      FAILURE_CODES.AUDIO_CLIP_CONVERSION_FAILED
    )
  );
  return { source: "file", durationMs: Math.round((frames * 1000) / STREAM_RATE) };
}

/** Gives the microphone back. With no feeder connected there is nothing of ours to clear. */
export async function clearRemoteAudioInput(session: RemoteAudioSession): Promise<void> {
  if (session.link && !session.link.closed) await session.link.request("MIC");
}

interface RemoteStatusRecord {
  bundleId: string;
  alive: boolean;
  status: AppAudioStatus;
}

async function readRemoteStatus(session: RemoteAudioSession): Promise<RemoteStatusRecord[]> {
  const link = await ensureLink(session);
  return link.request("STATUS", undefined, async (rest, deadline) => {
    const count = Number(rest) || 0;
    const records: RemoteStatusRecord[] = [];
    for (let i = 0; i < count; i++) {
      const [bundleId, alive, len] = (await link.readLine(deadline)).split(" ");
      const text = (await link.readBytes(Number(len) || 0, deadline)).toString("utf8");
      records.push({ bundleId: bundleId!, alive: alive === "1", status: parseAppStatus(text) });
    }
    return records;
  });
}

/** Bundle ids of the apps whose hook is live on the remote simulator. */
export async function listRemoteLiveApps(session: RemoteAudioSession): Promise<string[]> {
  return (await readRemoteStatus(session))
    .filter((r) => r.alive && r.status.pid > 0)
    .map((r) => r.bundleId);
}

export async function readRemoteAppHook(
  session: RemoteAudioSession,
  bundleId: string
): Promise<{ state: HookState; status: AppAudioStatus | null }> {
  const record = (await readRemoteStatus(session)).find((r) => r.bundleId === bundleId);
  if (!record) return { state: "none", status: null };
  const { stdout } = await simctlSpawn(session.udid, { args: ["launchctl", "list"] }).catch(() => ({
    stdout: "",
  }));
  const running = parseUIKitApplicationJobs(stdout).get(bundleId) ?? null;
  return { state: decideHookState(record.status, record.alive, running), status: record.status };
}

/** Disconnecting makes the feeder give the microphone back and exit. */
export async function releaseRemoteAudio(session: RemoteAudioSession): Promise<void> {
  const link = session.link;
  session.link = null;
  await link?.close();
}
