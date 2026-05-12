import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// link-config.ts captures LINK_DIR/LINK_FILE from `homedir()` at module load.
// Same HOME-redirection pattern as launcher-state.test.ts so all writes land in
// an isolated temp dir and the developer's real ~/.argent/link.json is safe.
let linkConfig: typeof import("../src/link-config.js");
let TEST_HOME: string;
let LINK_FILE: string;

beforeAll(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "argent-link-config-test-"));
  process.env.HOME = TEST_HOME;
  vi.resetModules();
  linkConfig = await import("../src/link-config.js");
  LINK_FILE = linkConfig.LINK_PATHS.LINK_FILE;
  expect(LINK_FILE.startsWith(TEST_HOME)).toBe(true);
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(async () => {
  await linkConfig.clearLinkConfig();
});

// `getResolvedToolsUrl` reads ARGENT_TOOLS_URL on every call (not at load), so
// any test that touches precedence must save & restore the variable.
let savedEnvUrl: string | undefined;
beforeEach(() => {
  savedEnvUrl = process.env.ARGENT_TOOLS_URL;
  delete process.env.ARGENT_TOOLS_URL;
});
afterEach(() => {
  if (savedEnvUrl === undefined) delete process.env.ARGENT_TOOLS_URL;
  else process.env.ARGENT_TOOLS_URL = savedEnvUrl;
});

const sampleConfig = {
  url: "http://10.0.0.42:3001",
  host: "10.0.0.42",
  port: 3001,
  createdAt: "2026-05-12T10:00:00.000Z",
};

describe("writeLinkConfig ↔ readLinkConfig round-trip", () => {
  it("persists every documented field", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    const read = await linkConfig.readLinkConfig();
    expect(read).toEqual(sampleConfig);
  });

  it("creates the .argent directory if it does not exist", async () => {
    rmSync(join(TEST_HOME, ".argent"), { recursive: true, force: true });
    await linkConfig.writeLinkConfig(sampleConfig);
    expect(existsSync(LINK_FILE)).toBe(true);
  });

  it("overwrites prior config on subsequent writes", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    await linkConfig.writeLinkConfig({ ...sampleConfig, port: 9999, url: "http://10.0.0.42:9999" });
    const read = await linkConfig.readLinkConfig();
    expect(read?.port).toBe(9999);
    expect(read?.url).toBe("http://10.0.0.42:9999");
  });

  it("writes pretty-printed JSON with a trailing newline (human-editable on disk)", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    const raw = readFileSync(LINK_FILE, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    // Pretty-printing puts each top-level field on its own line.
    expect(raw.split("\n").length).toBeGreaterThan(3);
  });
});

describe("readLinkConfig — failure & validation paths", () => {
  it("returns null when the file does not exist", async () => {
    expect(await linkConfig.readLinkConfig()).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", async () => {
    writeFileSync(LINK_FILE, "{ this is not json }", "utf8");
    expect(await linkConfig.readLinkConfig()).toBeNull();
  });

  // The reader hard-validates the schema. Each required field must be present
  // and have the documented type — partial files are treated as corrupt
  // (return null) so callers fall back to auto-spawn instead of dispatching
  // requests to a bogus URL.
  it.each([["url"], ["host"], ["port"], ["createdAt"]])(
    "returns null when required field %p is missing",
    async (field) => {
      const partial: Record<string, unknown> = { ...sampleConfig };
      delete partial[field];
      writeFileSync(LINK_FILE, JSON.stringify(partial), "utf8");
      expect(await linkConfig.readLinkConfig()).toBeNull();
    }
  );

  it.each([
    ["url", 42],
    ["host", null],
    ["port", "3001"], // string where number expected
    ["createdAt", 12345],
  ])("returns null when field %p has the wrong type", async (field, wrongValue) => {
    const corrupt = { ...sampleConfig, [field]: wrongValue };
    writeFileSync(LINK_FILE, JSON.stringify(corrupt), "utf8");
    expect(await linkConfig.readLinkConfig()).toBeNull();
  });
});

describe("clearLinkConfig", () => {
  it("removes the link file", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    expect(existsSync(LINK_FILE)).toBe(true);
    await linkConfig.clearLinkConfig();
    expect(existsSync(LINK_FILE)).toBe(false);
  });

  it("is a no-op when the file is already gone (idempotent)", async () => {
    await expect(linkConfig.clearLinkConfig()).resolves.toBeUndefined();
    await expect(linkConfig.clearLinkConfig()).resolves.toBeUndefined();
  });
});

describe("getResolvedToolsUrl — precedence chain", () => {
  it("returns source 'none' with null url when neither env nor link is set", async () => {
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved).toEqual({ url: null, source: "none" });
  });

  it("returns source 'link' when only a link file exists", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved.source).toBe("link");
    expect(resolved.url).toBe(sampleConfig.url);
    // No shadowedLink when env was not the winning source.
    expect(resolved.shadowedLink).toBeUndefined();
  });

  it("returns source 'env' when only ARGENT_TOOLS_URL is set", async () => {
    process.env.ARGENT_TOOLS_URL = "http://override.example:9000";
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved.source).toBe("env");
    expect(resolved.url).toBe("http://override.example:9000");
    expect(resolved.shadowedLink).toBeUndefined();
  });

  it("env wins over link, AND reports the shadowed link so callers can warn", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    process.env.ARGENT_TOOLS_URL = "http://override.example:9000";

    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved.source).toBe("env");
    expect(resolved.url).toBe("http://override.example:9000");
    // The whole point of shadowedLink: surface the persisted target that is
    // currently being overridden, without changing precedence.
    expect(resolved.shadowedLink).toEqual(sampleConfig);
  });

  it("ignores an empty ARGENT_TOOLS_URL (falsy string → falls through to link/none)", async () => {
    process.env.ARGENT_TOOLS_URL = "";
    await linkConfig.writeLinkConfig(sampleConfig);
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved.source).toBe("link");
    expect(resolved.url).toBe(sampleConfig.url);
  });

  it("a corrupt link file degrades gracefully when env is also set (no shadowedLink, no throw)", async () => {
    writeFileSync(LINK_FILE, "{ not json", "utf8");
    process.env.ARGENT_TOOLS_URL = "http://override.example:9000";
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved.source).toBe("env");
    expect(resolved.url).toBe("http://override.example:9000");
    expect(resolved.shadowedLink).toBeUndefined();
  });

  it("a corrupt link file with no env falls through to source 'none'", async () => {
    writeFileSync(LINK_FILE, "{ not json", "utf8");
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved).toEqual({ url: null, source: "none" });
  });
});

describe("isRemoteRouted", () => {
  it("returns false when neither env nor link is configured", async () => {
    expect(await linkConfig.isRemoteRouted()).toBe(false);
  });

  it("returns true when a link file is configured", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    expect(await linkConfig.isRemoteRouted()).toBe(true);
  });

  it("returns true when ARGENT_TOOLS_URL is set (regardless of link presence)", async () => {
    process.env.ARGENT_TOOLS_URL = "http://override.example:9000";
    expect(await linkConfig.isRemoteRouted()).toBe(true);
  });

  it("is gated on a *valid* link file — corrupt JSON does not count as routed", async () => {
    writeFileSync(LINK_FILE, "{ not json", "utf8");
    expect(await linkConfig.isRemoteRouted()).toBe(false);
  });
});
