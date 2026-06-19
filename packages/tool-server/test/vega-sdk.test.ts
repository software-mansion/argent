import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable virtual filesystem + a controllable Vega-CLI resolver, shared with the
// hoisted module mocks below.
const fsState = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  dirs: {} as Record<string, string[]>,
  existing: new Set<string>(),
}));
const mocks = vi.hoisted(() => ({
  resolveVegaBinary: vi.fn(async (): Promise<string | null> => "/home/u/vega/bin/vega"),
}));

vi.mock("node:os", () => ({ homedir: () => "/home/u", tmpdir: () => "/tmp" }));
vi.mock("node:fs", () => ({ existsSync: (p: string) => fsState.existing.has(p) }));
vi.mock("node:fs/promises", () => ({
  readFile: async (p: string) => {
    if (p in fsState.files) return fsState.files[p];
    throw new Error(`ENOENT ${p}`);
  },
  readdir: async (p: string, opts?: { withFileTypes?: boolean }) => {
    if (!(p in fsState.dirs)) throw new Error(`ENOENT ${p}`);
    const names = fsState.dirs[p]!;
    return opts?.withFileTypes ? names.map((n) => ({ name: n, isDirectory: () => true })) : names;
  },
}));
vi.mock("../src/utils/vega-cli", () => ({ resolveVegaBinary: mocks.resolveVegaBinary }));

import { resolveVegaSdkImagesDir, listVvdImages } from "../src/utils/vega-sdk";

const CONFIG = "/home/u/vega/config.json";
const IMAGES = "/home/u/vega/sdk/vega-sdk/main/0.22.6759/vvd/images";

beforeEach(() => {
  fsState.files = {};
  fsState.dirs = {};
  fsState.existing = new Set();
  mocks.resolveVegaBinary.mockResolvedValue("/home/u/vega/bin/vega"); // CLI on PATH by default
});

describe("resolveVegaSdkImagesDir", () => {
  it("builds the images dir from config, appending vega-sdk and stripping the channel@ version prefix", async () => {
    fsState.files[CONFIG] = JSON.stringify({
      sdkPath: "/home/u/vega/sdk", // points at the parent of vega-sdk
      defaultChannel: "main",
      defaultVersion: "main@0.22.6759", // channel-prefixed; dir is the bare version
    });
    fsState.existing.add("/home/u/vega/sdk/vega-sdk/main/0.22.6759");
    fsState.existing.add(IMAGES);

    expect(await resolveVegaSdkImagesDir()).toBe(IMAGES);
  });

  it("falls back to the highest installed semver when config has no version", async () => {
    fsState.files[CONFIG] = JSON.stringify({ sdkPath: "/home/u/vega/sdk", defaultChannel: "main" });
    fsState.dirs["/home/u/vega/sdk/vega-sdk/main"] = ["0.21.1", "0.22.6759", "not-a-version"];
    fsState.existing.add(IMAGES);

    expect(await resolveVegaSdkImagesDir()).toBe(IMAGES);
  });

  it("returns null when the Vega CLI is not on PATH", async () => {
    mocks.resolveVegaBinary.mockResolvedValue(null);
    fsState.files[CONFIG] = JSON.stringify({
      sdkPath: "/home/u/vega/sdk",
      defaultChannel: "main",
      defaultVersion: "0.22.6759",
    });
    fsState.existing.add(IMAGES);

    expect(await resolveVegaSdkImagesDir()).toBeNull();
  });

  it("returns null when the CLI is present but no image set is installed", async () => {
    expect(await resolveVegaSdkImagesDir()).toBeNull();
  });
});

describe("listVvdImages", () => {
  it("lists each image subdirectory with its package-root path", async () => {
    fsState.files[CONFIG] = JSON.stringify({
      sdkPath: "/home/u/vega/sdk",
      defaultChannel: "main",
      defaultVersion: "0.22.6759",
    });
    fsState.existing.add("/home/u/vega/sdk/vega-sdk/main/0.22.6759");
    fsState.existing.add(IMAGES);
    fsState.dirs[IMAGES] = ["tv"];

    expect(await listVvdImages()).toEqual([{ name: "tv", path: `${IMAGES}/tv` }]);
  });

  it("returns [] when the SDK is absent", async () => {
    mocks.resolveVegaBinary.mockResolvedValue(null);
    expect(await listVvdImages()).toEqual([]);
  });
});
