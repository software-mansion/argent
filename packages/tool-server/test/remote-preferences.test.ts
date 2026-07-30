import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import supertest from "supertest";
import { readConfigObject, readFlags } from "@argent/configuration-core";
import type { Registry } from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../src/http";

// This test exercises the top-level auth boundary, but not the unauthenticated
// preview UI. Keeping that subtree out of the module graph also keeps the test
// independent of optional simulator transports such as @moq/net.
vi.mock("../src/preview", async () => {
  const express = await import("express");
  return { createPreviewRouter: () => express.Router() };
});

vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    latestVersion: null,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => true),
  suppressUpdateNote: vi.fn(),
}));

function stubRegistry(): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: [] })),
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as Registry;
}

const TOKEN = "remote-preferences-token";
let handle: HttpAppHandle;
let tmpHome: string;
let originalHome: string | undefined;
let originalToken: string | undefined;

beforeEach(() => {
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-server-sync-")));
  originalHome = process.env.HOME;
  originalToken = process.env.ARGENT_AUTH_TOKEN;
  process.env.HOME = tmpHome;
  process.env.ARGENT_AUTH_TOKEN = TOKEN;
  handle = createHttpApp(stubRegistry());
});

afterEach(() => {
  handle.dispose();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
  else process.env.ARGENT_AUTH_TOKEN = originalToken;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("PUT /preferences/sync", () => {
  it("is protected by the tool-server bearer token", async () => {
    const response = await supertest(handle.app)
      .put("/preferences/sync")
      .send({ version: 1, flags: {} });
    expect(response.status).toBe(401);
  });

  it("applies portable flags and the telemetry opt-out on the server host", async () => {
    const response = await supertest(handle.app)
      .put("/preferences/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        version: 1,
        flags: {
          "video-watermark": false,
          "disable-auto-screenshot": true,
          "unknown": true,
        },
        telemetry: { enabled: false },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      version: 1,
      appliedFlags: ["video-watermark"],
      ignoredFlags: ["disable-auto-screenshot", "unknown"],
      telemetryDisabled: true,
    });
    expect(readFlags("global", { homeDir: tmpHome })).toEqual({
      "video-watermark": false,
    });
    expect(readConfigObject()).toMatchObject({ telemetry: { enabled: false } });
  });

  it("rejects arbitrary preference values", async () => {
    const response = await supertest(handle.app)
      .put("/preferences/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ version: 1, flags: {}, telemetry: { enabled: true } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/may only be false/);
  });
});
