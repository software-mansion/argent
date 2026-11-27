import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.unmock("../src/utils/argent-cloud-bin");

import {
  __resetArgentCloudBinForTests,
  argentCloudCommand,
  argentCloudVersion,
  findArgentCloudBin,
  isArgentCloudOutdated,
  parseArgentCloudVersion,
} from "../src/utils/argent-cloud-bin";
import { simctlListDevices } from "../src/utils/sim-remote";

const ENV_KEYS = ["PATH", "HOME", "ARGENT_CLOUD_BIN"] as const;
const saved: Record<string, string | undefined> = {};

let root: string;
let pathDir: string;
let localBin: string;

async function stub(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

const LIST_JSON = `echo '{"devices":{}}'`;

describe.skipIf(process.platform === "win32")("Argent Cloud CLI resolution", () => {
  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = await mkdtemp(join(tmpdir(), "argent-cloud-bin-"));
    pathDir = join(root, "path");
    localBin = join(root, "home", ".local", "bin");
    await mkdir(pathDir, { recursive: true });
    process.env.PATH = pathDir;
    process.env.HOME = join(root, "home");
    delete process.env.ARGENT_CLOUD_BIN;
    __resetArgentCloudBinForTests();
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetArgentCloudBinForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("finds nothing when no CLI is installed", async () => {
    expect(await findArgentCloudBin()).toBeNull();
    expect(argentCloudCommand()).toBe("sim-remote");
  });

  it("keeps the legacy sim-remote on PATH working", async () => {
    await stub(pathDir, "sim-remote", "exit 0");
    expect(await findArgentCloudBin()).toBe("sim-remote");
  });

  it("finds sim-remote in ~/.local/bin when PATH lacks it", async () => {
    const local = await stub(localBin, "sim-remote", "exit 0");
    expect(await findArgentCloudBin()).toBe(local);
  });

  it("prefers argent-cloud in ~/.local/bin over sim-remote on PATH", async () => {
    await stub(pathDir, "sim-remote", "exit 0");
    const local = await stub(localBin, "argent-cloud", "exit 0");
    expect(await findArgentCloudBin()).toBe(local);
  });

  it("prefers argent-cloud on PATH over ~/.local/bin", async () => {
    await stub(pathDir, "argent-cloud", "exit 0");
    await stub(localBin, "argent-cloud", "exit 0");
    expect(await findArgentCloudBin()).toBe("argent-cloud");
  });

  it("prefers ARGENT_CLOUD_BIN over everything", async () => {
    await stub(pathDir, "argent-cloud", "exit 0");
    const custom = await stub(join(root, "custom"), "my-cloud", "exit 0");
    process.env.ARGENT_CLOUD_BIN = custom;
    expect(await findArgentCloudBin()).toBe(custom);
  });

  it("looks again after the cached binary disappears", async () => {
    const legacy = await stub(pathDir, "sim-remote", LIST_JSON);
    await simctlListDevices();
    expect(argentCloudCommand()).toBe("sim-remote");

    await rm(legacy);
    await stub(pathDir, "argent-cloud", LIST_JSON);
    await expect(simctlListDevices()).rejects.toThrow(/ENOENT/);

    await expect(simctlListDevices()).resolves.toEqual({ devices: {} });
    expect(argentCloudCommand()).toBe("argent-cloud");
  });

  it("reads no version from a CLI without --version", async () => {
    await stub(
      pathDir,
      "sim-remote",
      `echo "error: unexpected argument '--version' found" >&2; exit 2`
    );
    expect(await argentCloudVersion()).toBeNull();
  });

  it("reads the version a newer CLI prints", async () => {
    await stub(pathDir, "argent-cloud", `echo "argent-cloud 1.0.9"`);
    expect(await argentCloudVersion()).toBe("1.0.9");
  });
});

describe("Argent Cloud CLI version", () => {
  it("parses `<name> x.y.z` and nothing else", () => {
    expect(parseArgentCloudVersion("argent-cloud 1.1.0\n")).toBe("1.1.0");
    expect(parseArgentCloudVersion("sim-remote 1.2.0-rc.1")).toBe("1.2.0-rc.1");
    expect(parseArgentCloudVersion("Usage: sim-remote [OPTIONS] <COMMAND>")).toBeNull();
    expect(parseArgentCloudVersion('{"devices":{"iOS-26-1":[]}}')).toBeNull();
  });

  it("flags only versions below the minimum", () => {
    expect(isArgentCloudOutdated("1.0.9")).toBe(true);
    expect(isArgentCloudOutdated("1.1.0")).toBe(false);
    expect(isArgentCloudOutdated("1.1.0-rc.1")).toBe(false);
    expect(isArgentCloudOutdated("2.0.0")).toBe(false);
  });
});
