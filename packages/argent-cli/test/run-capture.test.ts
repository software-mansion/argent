import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setFlag, type FlagsPathOptions } from "@argent/configuration-core";
import {
  AUTO_DESCRIBE_HEADER,
  PROFILING_CAPTURE_SKIPPED_NOTE,
  SECRET_CAPTURE_SKIPPED_NOTE,
} from "@argent/tools-client";
import { captureAfterAction } from "../src/run-capture.js";

const SHOT = { localPath: "/tmp/after.png", data: Buffer.from("png"), mimeType: "image/png" };

vi.mock("@argent/tools-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    materializeArtifacts: vi.fn(async (result: unknown) => ({
      result,
      images: result === "shot-handle" ? [SHOT] : [],
    })),
  };
});

interface FakeServer {
  idle: unknown;
  describeFails?: boolean;
  noIdleTool?: boolean;
  screenshot?: unknown;
}

function fakeClient(server: FakeServer) {
  const order: string[] = [];
  const callTool = vi.fn(async (name: string) => {
    order.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`end:${name}`);
    if (name === "await-screen-idle") {
      if (server.noIdleTool) throw new Error('Tool "await-screen-idle" not found');
      return { data: server.idle };
    }
    if (name === "screenshot") return { data: server.screenshot ?? "shot-handle" };
    if (name === "describe") {
      if (server.describeFails) throw new Error("describe failed");
      return { data: { description: "button Done (0.1,0.2,0.3,0.1)", hint: "1 omitted." } };
    }
    throw new Error(`unexpected tool ${name}`);
  });
  const baseUrl = vi.fn(async () => ({ url: "http://127.0.0.1:1", token: "t" }));
  return { client: { callTool, baseUrl }, callTool, order };
}

function toolNames(callTool: ReturnType<typeof vi.fn>): string[] {
  return callTool.mock.calls.map((c) => String(c[0]));
}

describe("captureAfterAction", () => {
  let flagsPath: FlagsPathOptions;

  beforeEach(() => {
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-capture-home-")));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-capture-proj-")));
    fs.writeFileSync(path.join(cwd, "package.json"), "{}");
    flagsPath = { homeDir, cwd };
  });

  afterEach(() => {
    fs.rmSync(flagsPath.homeDir!, { recursive: true, force: true });
    fs.rmSync(flagsPath.cwd!, { recursive: true, force: true });
  });

  const tap = { udid: "SIM-1", x: 0.5, y: 0.5 };

  it("waits for the screen to settle, then returns the screenshot file and the tree", async () => {
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "gesture-tap",
      payload: tap,
      profiling: false,
      flagsPath,
    });

    expect(callTool.mock.calls[0]).toEqual([
      "await-screen-idle",
      { udid: "SIM-1", timeoutMs: 1500 },
      expect.anything(),
    ]);
    expect(toolNames(callTool).slice(1).sort()).toEqual(["describe", "screenshot"]);
    expect(capture.lines).toEqual([
      "Screen after action: /tmp/after.png",
      AUTO_DESCRIBE_HEADER,
      "Hint: 1 omitted.\nbutton Done (0.1,0.2,0.3,0.1)",
    ]);
    expect(capture.screenshot).toBe(SHOT);
    expect(capture.note).toBeUndefined();
  });

  it("reads the { url, path } screenshot of an older tool-server", async () => {
    const png = Buffer.from("legacy-png");
    const server = http.createServer((_req, res) => res.end(png));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const { client } = fakeClient({
      idle: { settled: true },
      screenshot: { url: `http://127.0.0.1:${port}/shot.png`, path: "/srv/shot.png" },
    });

    try {
      const capture = await captureAfterAction({
        client,
        toolName: "gesture-tap",
        payload: tap,
        profiling: false,
        flagsPath,
      });

      expect(capture.lines[0]).toBe("Screen after action: /srv/shot.png");
      expect(capture.screenshot?.data).toEqual(png);
    } finally {
      server.close();
    }
  });

  it("reads the tree only after the screenshot when the screen did not settle", async () => {
    const { client, order } = fakeClient({ idle: { settled: false } });

    await captureAfterAction({
      client,
      toolName: "gesture-tap",
      payload: tap,
      profiling: false,
      flagsPath,
    });

    expect(order.indexOf("start:describe")).toBeGreaterThan(order.indexOf("end:screenshot"));
  });

  it("skips the tree with disable-auto-describe", async () => {
    setFlag("disable-auto-describe", true, "global", flagsPath);
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "gesture-tap",
      payload: tap,
      profiling: false,
      flagsPath,
    });

    expect(toolNames(callTool)).toEqual(["await-screen-idle", "screenshot"]);
    expect(capture.lines).toEqual(["Screen after action: /tmp/after.png"]);
  });

  it("skips the screenshot with disable-auto-screenshot", async () => {
    setFlag("disable-auto-screenshot", true, "global", flagsPath);
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "gesture-tap",
      payload: tap,
      profiling: false,
      flagsPath,
    });

    expect(toolNames(callTool)).toEqual(["await-screen-idle", "describe"]);
    expect(capture.lines[0]).toBe(AUTO_DESCRIBE_HEADER);
    expect(capture.screenshot).toBeUndefined();
  });

  it("neither waits nor captures with both flags set", async () => {
    setFlag("disable-auto-screenshot", true, "global", flagsPath);
    setFlag("disable-auto-describe", true, "project", flagsPath);
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "gesture-tap",
      payload: tap,
      profiling: false,
      flagsPath,
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(capture).toEqual({ lines: [] });
  });

  it.each([
    ["a tool that does not change the screen", "list-devices", { udid: "SIM-1" }],
    ["a call without a udid", "gesture-tap", { x: 0.5, y: 0.5 }],
    ["a menu-bar list", "menu-bar", { udid: "SIM-1", action: "list" }],
  ])("does nothing after %s", async (_label, toolName, payload) => {
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName,
      payload,
      profiling: false,
      flagsPath,
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(capture.lines).toEqual([]);
  });

  it("adds only the screenshot after describe, whose result is the tree", async () => {
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "describe",
      payload: { udid: "SIM-1" },
      profiling: false,
      flagsPath,
    });

    expect(toolNames(callTool)).toEqual(["await-screen-idle", "screenshot"]);
    expect(capture.lines).toEqual(["Screen after action: /tmp/after.png"]);
  });

  it("captures nothing after a call that types a secret", async () => {
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "keyboard",
      payload: { udid: "SIM-1", text: "{{secret:PASSWORD}}" },
      profiling: false,
      flagsPath,
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(capture).toEqual({ lines: [], note: SECRET_CAPTURE_SKIPPED_NOTE });
  });

  it("waits but does not capture while a profiler records", async () => {
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "gesture-tap",
      payload: tap,
      profiling: true,
      flagsPath,
    });

    expect(toolNames(callTool)).toEqual(["await-screen-idle"]);
    expect(capture).toEqual({ lines: [], note: PROFILING_CAPTURE_SKIPPED_NOTE });
  });

  it("keeps the screenshot when describe fails", async () => {
    const { client } = fakeClient({ idle: { settled: true }, describeFails: true });

    const capture = await captureAfterAction({
      client,
      toolName: "gesture-tap",
      payload: tap,
      profiling: false,
      flagsPath,
    });

    expect(capture.lines).toEqual(["Screen after action: /tmp/after.png"]);
  });

  it("sleeps out the settle budget on a tool-server without await-screen-idle", async () => {
    const { client, callTool } = fakeClient({ idle: null, noIdleTool: true });
    const started = Date.now();

    const capture = await captureAfterAction({
      client,
      toolName: "keyboard",
      payload: { udid: "SIM-1", text: "hi" },
      profiling: false,
      flagsPath,
    });

    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(toolNames(callTool)).toEqual(["await-screen-idle", "screenshot", "describe"]);
    expect(capture.lines[0]).toBe("Screen after action: /tmp/after.png");
  });

  it("neither waits nor notes anything after describe while a profiler records", async () => {
    const { client, callTool } = fakeClient({ idle: { settled: true } });

    const capture = await captureAfterAction({
      client,
      toolName: "describe",
      payload: { udid: "SIM-1" },
      profiling: true,
      flagsPath,
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(capture).toEqual({ lines: [] });
  });
});
