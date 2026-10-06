import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, type ReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareFileInputs, type FileInputSpec } from "../src/file-inputs.js";

// A signal or `process.exit()` ends the process before the `finally` that
// removes an upload's archive can run, so prepareFileInputs listens for both
// while an upload is in progress. These cases own the signal listeners of this fork: the ones
// already present are set aside, so `process.kill` is reached only when the
// upload's listener is the last one, and put back afterwards.
const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const specs: FileInputSpec[] = [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }];

let tmpDir: string;
let appDir: string;
let setAside: Array<[NodeJS.Signals, NodeJS.SignalsListener[]]>;
// Uploads a case started. Each is finished after the case, so a failed
// assertion cannot leave one waiting with its archive on disk.
const uploads: Array<{ finish: () => void; done: Promise<unknown> }> = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-file-inputs-signal-"));
  appDir = path.join(tmpDir, "MyApp.app");
  await fs.mkdir(appDir);
  await fs.writeFile(path.join(appDir, "Info.plist"), "<plist/>");
  setAside = SIGNALS.map((signal) => {
    const listeners = process.listeners(signal) as NodeJS.SignalsListener[];
    process.removeAllListeners(signal);
    return [signal, listeners];
  });
});

afterEach(async () => {
  for (const { finish, done } of uploads.splice(0)) {
    finish();
    await done.catch(() => {});
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [signal, listeners] of setAside) {
    process.removeAllListeners(signal);
    for (const listener of listeners) process.on(signal, listener);
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Starts an upload that waits in `POST /upload` until `finish` is called. */
async function startUpload(): Promise<{
  archive: string;
  finish: () => void;
  done: Promise<unknown>;
}> {
  let archive = "";
  let finish = (): void => {};
  const uploading = new Promise<void>((resolve) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        // Like a real upload, hold the archive open before anything else runs.
        const body = init.body as unknown as ReadStream;
        archive = String(body.path);
        body.once("open", () => resolve());
        return new Promise((answer) => {
          finish = () => {
            body.destroy();
            answer({ ok: true, json: async () => ({ uploadId: "u-1" }) });
          };
        });
      })
    );
  });
  const done = prepareFileInputs(
    specs,
    { appPath: appDir },
    { includeContent: true, uploadEndpoint: { url: "https://sim.example", token: "tok" } }
  );
  await uploading;
  uploads.push({ finish: () => finish(), done });
  return { archive, finish: () => finish(), done };
}

describe("prepareFileInputs — a signal during an upload", () => {
  it("removes the archive and raises the signal again", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { archive, finish, done } = await startUpload();
    expect(path.basename(archive)).toMatch(/^argent-upload-.+\.tar\.gz$/);
    expect(existsSync(archive)).toBe(true);

    process.emit("SIGTERM", "SIGTERM");

    expect(existsSync(archive)).toBe(false);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    for (const signal of SIGNALS) expect(process.listenerCount(signal)).toBe(0);
    finish();
    await done;
  });

  it("removes the archive but leaves the signal to another listener", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const other = vi.fn();
    process.on("SIGINT", other);
    const { archive, finish, done } = await startUpload();

    process.emit("SIGINT", "SIGINT");

    expect(existsSync(archive)).toBe(false);
    expect(other).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    finish();
    await done;
  });

  it("exits with the signal's code when the signal cannot be raised again", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("kill ENOSYS");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { archive } = await startUpload();

    process.emit("SIGHUP", "SIGHUP");

    expect(existsSync(archive)).toBe(false);
    expect(exit).toHaveBeenCalledWith(129);
  });

  it("removes the archive when the process exits during an upload", async () => {
    const before = process.listeners("exit");
    const { archive } = await startUpload();
    const added = process.listeners("exit").filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);

    // What `process.exit()` runs. The listener is called directly, so this
    // fork does not exit.
    (added[0] as (code: number) => void)(0);

    expect(existsSync(archive)).toBe(false);
    expect(process.listeners("exit")).toEqual(before);
    for (const signal of SIGNALS) expect(process.listenerCount(signal)).toBe(0);
  });

  it("stops listening once the upload ends", async () => {
    const exitListeners = process.listenerCount("exit");
    const { archive, finish, done } = await startUpload();
    for (const signal of SIGNALS) expect(process.listenerCount(signal)).toBe(1);
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);

    finish();
    await done;

    expect(existsSync(archive)).toBe(false);
    for (const signal of SIGNALS) expect(process.listenerCount(signal)).toBe(0);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });
});
