import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolsClient = vi.hoisted(() => ({
  readLinkConfig: vi.fn(),
  writeLinkConfig: vi.fn(),
}));
const syncLinkedServerPreferences = vi.hoisted(() => vi.fn());
const prompts = vi.hoisted(() => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  text: vi.fn(),
}));

vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  readLinkConfig: toolsClient.readLinkConfig,
  writeLinkConfig: toolsClient.writeLinkConfig,
}));

vi.mock("../src/remote-preferences.js", () => ({ syncLinkedServerPreferences }));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  ...prompts,
  log: { error: vi.fn(), info: vi.fn() },
}));

import { link } from "../src/link.js";

const TARGET = "http://127.0.0.1:3001";
const SYNCED = {
  status: "synced" as const,
  telemetryDisabled: false,
};

describe("link preference sync orchestration", () => {
  const originalToolsUrl = process.env.ARGENT_TOOLS_URL;

  beforeEach(() => {
    delete process.env.ARGENT_TOOLS_URL;
    toolsClient.readLinkConfig.mockReset().mockResolvedValue(null);
    toolsClient.writeLinkConfig.mockReset().mockResolvedValue(undefined);
    syncLinkedServerPreferences.mockReset().mockResolvedValue(SYNCED);
    prompts.confirm.mockReset();
    prompts.isCancel.mockClear();
    prompts.select.mockReset();
    prompts.spinner.mockClear();
    prompts.text.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalToolsUrl === undefined) delete process.env.ARGENT_TOOLS_URL;
    else process.env.ARGENT_TOOLS_URL = originalToolsUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("syncs by default after persisting a new link", async () => {
    await link([TARGET, "--no-verify"]);

    expect(toolsClient.writeLinkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: TARGET, host: "127.0.0.1", port: 3001 })
    );
    expect(syncLinkedServerPreferences).toHaveBeenCalledWith(TARGET, undefined);
    expect(toolsClient.writeLinkConfig.mock.invocationCallOrder[0]).toBeLessThan(
      syncLinkedServerPreferences.mock.invocationCallOrder[0]!
    );
  });

  it("honors --no-sync-preferences", async () => {
    await link([TARGET, "--no-verify", "--no-sync-preferences"]);

    expect(toolsClient.writeLinkConfig).toHaveBeenCalledOnce();
    expect(syncLinkedServerPreferences).not.toHaveBeenCalled();
  });

  it("refreshes preferences when linking the same target again", async () => {
    toolsClient.readLinkConfig.mockResolvedValue({
      url: TARGET,
      host: "127.0.0.1",
      port: 3001,
      token: "existing-token",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await link([TARGET, "--no-verify"]);

    expect(toolsClient.writeLinkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ url: TARGET, token: "existing-token" })
    );
    expect(syncLinkedServerPreferences).toHaveBeenCalledWith(TARGET, "existing-token");
  });

  it("reports the final target after verification modifies a same-target link", async () => {
    toolsClient.readLinkConfig.mockResolvedValue({
      url: TARGET,
      host: "127.0.0.1",
      port: 3001,
      token: "existing-token",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    prompts.select.mockResolvedValueOnce("modify");
    prompts.text.mockResolvedValueOnce("localhost").mockResolvedValueOnce("3002");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await link([TARGET]);

    expect(toolsClient.writeLinkConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://localhost:3002",
        host: "localhost",
        port: 3002,
      })
    );
    expect(toolsClient.writeLinkConfig.mock.calls[0]![0]).not.toHaveProperty("token");
    expect(syncLinkedServerPreferences).toHaveBeenCalledWith("http://localhost:3002", undefined);
    expect(fetchMock.mock.calls[1]![1]).toEqual(expect.objectContaining({ headers: {} }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Link updated:"));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Link refreshed:"));
  });

  it("keeps the saved link when preference sync fails", async () => {
    syncLinkedServerPreferences.mockResolvedValue({ status: "failed", error: "offline" });

    await expect(link([TARGET, "--no-verify"])).resolves.toBeUndefined();

    expect(toolsClient.writeLinkConfig).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("link saved anyway"));
  });
});
