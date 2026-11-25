import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { InvalidToolInputError } from "../src/utils/capability";
import { proxyStop, simctlSpawn } from "../src/utils/sim-remote";
import {
  createRemoteAudioSession,
  listRemoteLiveApps,
  readRemoteAppHook,
  releaseRemoteAudio,
  setRemoteAudioInput,
  type RemoteAudioSession,
} from "../src/utils/ios-audio-remote";

vi.mock("@argent/native-devtools-ios", () => ({
  audioDylibPathTcp: () => "/fake/libArgentAudio.dylib",
  audioFeederPathTcp: () => "/fake/argent-audio-feeder",
}));

/** What the fake feeder in the simulator saw: each command line, and the bytes after a FILE line. */
interface Feeder {
  commands: string[];
  payloads: Buffer[];
  closed: Promise<void>;
}
let feeders: Feeder[] = [];
let reply: (command: string) => string = () => "OK";
const answer = (socket: net.Socket, text: string) =>
  socket.write(text.endsWith("\n") ? text : text + "\n");

/** Plays the feeder: connects back to the tool-server's port, greets with the token, answers each command. */
function startFeeder(port: number, token: string): void {
  const socket = net.connect(port, "127.0.0.1");
  const feeder: Feeder = {
    commands: [],
    payloads: [],
    closed: new Promise((resolve) => socket.on("close", () => resolve())),
  };
  feeders.push(feeder);
  let buf = Buffer.alloc(0);
  let pending = -1;
  socket.on("error", () => {});
  socket.on("connect", () => socket.write(`HELLO ${token} 4242\n`));
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (pending >= 0) {
        if (buf.length < pending) return;
        feeder.payloads.push(buf.subarray(0, pending));
        buf = buf.subarray(pending);
        pending = -1;
        answer(socket, reply(feeder.commands.at(-1)!));
        continue;
      }
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString("utf8");
      buf = buf.subarray(nl + 1);
      feeder.commands.push(line);
      if (line.startsWith("FILE ")) pending = Number(line.split(" ")[2]);
      else answer(socket, reply(line));
    }
  });
}

vi.mock("../src/utils/sim-remote", () => ({
  proxyStart: vi.fn(async () => {}),
  proxyStop: vi.fn(async () => {}),
  injectDylib: vi.fn(async () => {}),
  setSimulatorEnv: vi.fn(async () => {}),
  simctlSpawn: vi.fn(async (_udid: string, opts: { binPath?: string; args?: string[] }) => {
    const args = opts.args ?? [];
    if (opts.binPath) {
      startFeeder(Number(args[1]), args[2]!);
      return { pid: 4242, stdout: "", stderr: "" };
    }
    if (args[0] === "launchctl" && args[1] === "list") {
      return { stdout: "1234\t0\tUIKitApplication:com.x.app[abcd][rb-legacy]\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }),
}));

const feederSpawns = () => vi.mocked(simctlSpawn).mock.calls.filter(([, o]) => o.binPath).length;

let session: RemoteAudioSession;
let tmp: string;

beforeEach(() => {
  vi.clearAllMocks();
  feeders = [];
  reply = () => "OK";
  session = createRemoteAudioSession("remote:0000AAAA-0000-0000-0000-000000000001");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argent-remote-audio-"));
});

afterEach(async () => {
  await releaseRemoteAudio(session);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("remote audio feeder link", () => {
  it("sends the file's bytes after FILE and derives the duration from the decoded frames", async () => {
    const file = path.join(tmp, "clip.m4a");
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    fs.writeFileSync(file, bytes);
    reply = (cmd) => (cmd.startsWith("FILE") ? "OK 144000" : "OK");

    const result = await setRemoteAudioInput(session, { kind: "file", path: file, plays: 2 });

    expect(result).toEqual({ source: "file", durationMs: 3000 });
    expect(feeders[0]!.commands).toEqual([`FILE 2 ${bytes.length}`]);
    expect(feeders[0]!.payloads).toEqual([bytes]);
  });

  it("maps a decode refusal to AUDIO_CLIP_CONVERSION_FAILED and keeps the link usable", async () => {
    const file = path.join(tmp, "bad.bin");
    fs.writeFileSync(file, "not audio");
    reply = (cmd) => (cmd.startsWith("FILE") ? "ERR could not decode audio: bad format" : "OK");

    const err = await setRemoteAudioInput(session, { kind: "file", path: file, plays: 1 }).catch(
      (e: unknown) => e
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AUDIO_CLIP_CONVERSION_FAILED);

    await expect(
      setRemoteAudioInput(session, { kind: "tone", frequencyHz: 440, amplitude: 0.5 })
    ).resolves.toEqual({ source: "tone" });
    expect(feeders[0]!.commands.at(-1)).toBe("TONE 440 0.5");
  });

  it("lists only live apps from STATUS and reads a matching pid's hook state", async () => {
    const alive = "proto=1\npid=1234\nstate=dormant\n";
    const dead = "proto=1\npid=555\nstate=active\n";
    reply = (cmd) =>
      cmd === "STATUS"
        ? `OK 2\ncom.x.app 1 ${Buffer.byteLength(alive)}\n${alive}` +
          `com.y.gone 0 ${Buffer.byteLength(dead)}\n${dead}`
        : "OK";

    expect(await listRemoteLiveApps(session)).toEqual(["com.x.app"]);
    const hook = await readRemoteAppHook(session, "com.x.app");
    expect(hook.state).toBe("dormant");
    expect(hook.status?.pid).toBe(1234);
    // Both STATUS calls went over the first connection.
    expect(feederSpawns()).toBe(1);
  });

  it("reuses the connection for later commands", async () => {
    await setRemoteAudioInput(session, { kind: "tone", frequencyHz: 440, amplitude: 0.5 });
    await setRemoteAudioInput(session, { kind: "tone", frequencyHz: 880, amplitude: 0.2 });

    expect(feederSpawns()).toBe(1);
    expect(feeders[0]!.commands).toEqual(["TONE 440 0.5", "TONE 880 0.2"]);
  });

  it("closes the socket and the tunnel on release", async () => {
    await setRemoteAudioInput(session, { kind: "tone", frequencyHz: 440, amplitude: 0.5 });
    const port = Number(vi.mocked(simctlSpawn).mock.calls[0]![1].args![1]);

    await releaseRemoteAudio(session);

    await feeders[0]!.closed;
    expect(proxyStop).toHaveBeenCalledWith(session.udid, port);
    expect(session.link).toBeNull();
  });

  it("rejects a missing file before starting the feeder", async () => {
    const err = await setRemoteAudioInput(session, {
      kind: "file",
      path: path.join(tmp, "missing.wav"),
      plays: 1,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidToolInputError);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(simctlSpawn).not.toHaveBeenCalled();
  });
});
