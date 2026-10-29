import { promises as fs } from "node:fs";
import os from "node:os";
import { processNamespaceId } from "@argent/registry";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanupAbandonedFrames,
  createFrameDirectory,
  setFrameDirectoryOwner,
} from "../src/tools/screen-recording/frame-directory";
import { redirectTmpdir } from "./helpers/tmpdir-env";

vi.mock("@argent/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/registry")>()),
  processNamespaceId: vi.fn(async () => "aaaaaaaaaaaa"),
}));

let root = "";
let restore = () => {};
beforeEach(async () => {
  vi.spyOn(os, "platform").mockReturnValue("darwin");
  vi.mocked(processNamespaceId).mockResolvedValue("aaaaaaaaaaaa");
  root = await fs.mkdtemp(path.join(os.tmpdir(), "argent-spool-test-"));
  restore = redirectTmpdir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

it("reaps dead owners and leaves every live process's spools alone", async () => {
  const dead = path.join(root, "argent-recording-frames-999999-aaaaaaaaaaaa-dead");
  const live = path.join(root, "argent-recording-frames-12345-aaaaaaaaaaaa-live");
  await fs.mkdir(dead);
  await fs.mkdir(live);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(signal).toBe(0);
    if (pid === 999999) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  const created = await createFrameDirectory();
  expect(path.basename(created)).toContain(`argent-recording-frames-${process.pid}-`);
  await expect(fs.access(dead)).rejects.toThrow();
  await expect(fs.access(live)).resolves.toBeUndefined();
});

it("leaves ownerless, malformed and unrelated directories alone regardless of age", async () => {
  const names = [
    "argent-recording-frames-ownerless",
    "argent-recording-frames-0",
    "x".repeat("argent-recording-frames-".length) + "999999-unrelated",
  ];
  for (const name of names) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    await fs.utimes(directory, new Date(0), new Date(0));
  }
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await cleanupAbandonedFrames();
  expect(kill).not.toHaveBeenCalled();
  expect((await fs.readdir(root)).sort()).toEqual(names.sort());
});

it("reports an undeletable spool and still cleans the next one and creates a new capture", async () => {
  const blocked = path.join(root, "argent-recording-frames-123-aaaaaaaaaaaa-blocked");
  const removable = path.join(root, "argent-recording-frames-124-aaaaaaaaaaaa-removable");
  await fs.mkdir(blocked);
  await fs.mkdir(removable);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  const remove = fs.rm.bind(fs);
  vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (file === blocked) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    return remove(file, options);
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const created = await createFrameDirectory();
  await expect(fs.access(created)).resolves.toBeUndefined();
  await expect(fs.access(blocked)).resolves.toBeUndefined();
  await expect(fs.access(removable)).rejects.toThrow();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
});

it("keeps an orphan encoder's spool until its own process exits", async () => {
  const encoderPid = 12345;
  const directory = setFrameDirectoryOwner(await createFrameDirectory(), encoderPid);
  await fs.writeFile(path.join(directory, "0.jpg"), "frame");
  expect(path.basename(directory)).toMatch(/^argent-recording-frames-12345-/);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  await cleanupAbandonedFrames();
  expect(kill).toHaveBeenCalledWith(encoderPid, 0);
  expect(await fs.readFile(path.join(directory, "0.jpg"), "utf8")).toBe("frame");
  kill.mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await cleanupAbandonedFrames();
  await expect(fs.access(directory)).rejects.toThrow();
});

it.each(["Z", "S", "EPERM", "ENOENT"])(
  "checks Linux owner state before sweeping (%s)",
  async (state) => {
    const directory = await createFrameDirectory();
    const owned = setFrameDirectoryOwner(directory, 12345);
    vi.spyOn(os, "platform").mockReturnValue("linux");
    vi.spyOn(process, "kill").mockReturnValue(true);
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (file !== "/proc/12345/stat") return read(file, options);
      if (["EPERM", "ENOENT"].includes(state)) {
        throw Object.assign(new Error(state), { code: state });
      }
      return `12345 (ffmpeg (encoder)) ${state} 1 0 0`;
    });
    await cleanupAbandonedFrames();
    if (["Z", "ENOENT"].includes(state)) await expect(fs.access(owned)).rejects.toThrow();
    else await expect(fs.access(owned)).resolves.toBeUndefined();
  }
);

it.each(["bbbbbbbbbbbb", null])(
  "does not sweep another or unknown namespace (%s)",
  async (namespace) => {
    const directory = await createFrameDirectory();
    await fs.writeFile(path.join(directory, "0.jpg"), "frame");
    vi.mocked(processNamespaceId).mockResolvedValue(namespace);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not visible"), { code: "ESRCH" });
    });
    await cleanupAbandonedFrames();
    expect(kill).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, "0.jpg"), "utf8")).toBe("frame");
  }
);
