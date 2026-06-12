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

describe("token handling", () => {
  const withToken = { ...sampleConfig, token: "tok_abc123" };

  it("round-trips an optional token", async () => {
    await linkConfig.writeLinkConfig(withToken);
    expect(await linkConfig.readLinkConfig()).toEqual(withToken);
  });

  it("getResolvedToolsUrl surfaces the link token (source 'link')", async () => {
    await linkConfig.writeLinkConfig(withToken);
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved.source).toBe("link");
    expect(resolved.token).toBe("tok_abc123");
  });

  it("getResolvedToolsUrl omits token for a tokenless link", async () => {
    await linkConfig.writeLinkConfig(sampleConfig);
    const resolved = await linkConfig.getResolvedToolsUrl();
    expect(resolved.source).toBe("link");
    expect(resolved.token).toBeUndefined();
  });

  it("getResolvedToolsUrl takes the token from ARGENT_AUTH_TOKEN for source 'env'", async () => {
    const savedTok = process.env.ARGENT_AUTH_TOKEN;
    process.env.ARGENT_TOOLS_URL = "http://override.example:9000";
    process.env.ARGENT_AUTH_TOKEN = "env_tok_xyz";
    try {
      const resolved = await linkConfig.getResolvedToolsUrl();
      expect(resolved.source).toBe("env");
      expect(resolved.token).toBe("env_tok_xyz");
    } finally {
      if (savedTok === undefined) delete process.env.ARGENT_AUTH_TOKEN;
      else process.env.ARGENT_AUTH_TOKEN = savedTok;
    }
  });
});

describe("connection string (argent://)", () => {
  it("formats and round-trips host/port/token", () => {
    const s = linkConfig.formatLinkUrl({ host: "10.0.0.42", port: 3001, token: "tok_abc" });
    expect(s).toBe("argent://tok_abc@10.0.0.42:3001");
    expect(linkConfig.parseLinkUrl(s)).toEqual({ host: "10.0.0.42", port: 3001, token: "tok_abc" });
  });

  it("formats and parses a tokenless string", () => {
    const s = linkConfig.formatLinkUrl({ host: "10.0.0.42", port: 3001 });
    expect(s).toBe("argent://10.0.0.42:3001");
    expect(linkConfig.parseLinkUrl(s)).toEqual({ host: "10.0.0.42", port: 3001 });
  });

  it("brackets IPv6 literals", () => {
    expect(linkConfig.formatLinkUrl({ host: "::1", port: 3001 })).toBe("argent://[::1]:3001");
    expect(linkConfig.parseLinkUrl("argent://tok@[::1]:3001")).toEqual({
      host: "::1",
      port: 3001,
      token: "tok",
    });
  });

  it("returns null for a non-argent string", () => {
    expect(linkConfig.parseLinkUrl("http://10.0.0.42:3001")).toBeNull();
    expect(linkConfig.parseLinkUrl("10.0.0.42:3001")).toBeNull();
  });

  it("throws on a malformed argent:// string (missing port)", () => {
    expect(() => linkConfig.parseLinkUrl("argent://10.0.0.42")).toThrow();
  });
});

describe("parseLinkTarget (full URL)", () => {
  it("maps argent:// to an http URL", () => {
    expect(linkConfig.parseLinkTarget("argent://tok@10.0.0.42:3001")).toEqual({
      url: "http://10.0.0.42:3001",
      host: "10.0.0.42",
      port: 3001,
      token: "tok",
    });
  });

  it("parses an https URL with default port", () => {
    expect(linkConfig.parseLinkTarget("https://argent.example.com")).toEqual({
      url: "https://argent.example.com",
      host: "argent.example.com",
      port: 443,
    });
  });

  it("preserves explicit port + path and strips a trailing slash", () => {
    expect(linkConfig.parseLinkTarget("https://proxy.example.com:8443/argent/")).toEqual({
      url: "https://proxy.example.com:8443/argent",
      host: "proxy.example.com",
      port: 8443,
    });
  });

  it("reads a userinfo token on an http(s) URL", () => {
    expect(linkConfig.parseLinkTarget("https://tok_xyz@proxy.example.com")).toEqual({
      url: "https://proxy.example.com",
      host: "proxy.example.com",
      port: 443,
      token: "tok_xyz",
    });
  });

  it("brackets/keeps IPv6 hosts", () => {
    expect(linkConfig.parseLinkTarget("http://[::1]:3001")).toEqual({
      url: "http://[::1]:3001",
      host: "::1",
      port: 3001,
    });
  });

  it("returns null for a bare host or unknown scheme", () => {
    expect(linkConfig.parseLinkTarget("10.0.0.42")).toBeNull();
    expect(linkConfig.parseLinkTarget("ftp://example.com")).toBeNull();
  });

  it("throws on a malformed argent:// target (delegates to parseLinkUrl)", () => {
    expect(() => linkConfig.parseLinkTarget("argent://10.0.0.42")).toThrow();
  });
});
