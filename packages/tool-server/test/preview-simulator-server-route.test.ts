import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Registry } from "@argent/registry";
import type { LivePanel } from "../src/utils/foldable";

const resolveLivePanelMock = vi.fn<(udid: string) => Promise<LivePanel>>();
vi.mock("../src/utils/foldable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/foldable")>()),
  resolveLivePanel: (udid: string) => resolveLivePanelMock(udid),
}));

import { createPreviewRouter } from "../src/preview";

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const FLAT = "8BDBFD47-E557-41BA-926B-2DD39A17A53E";
const PANELS = [
  { screenId: 1, width: 1398, height: 2034 },
  { screenId: 3, width: 2007, height: 2853 },
];

function makeApp() {
  const registry = {
    invokeTool: vi.fn(async () => ({
      devices: [
        { platform: "ios", udid: DUO },
        { platform: "ios", udid: FLAT },
      ],
    })),
    resolveService: vi.fn(async (urn: string) => ({
      apiUrl: "http://127.0.0.1:61830",
      streamUrl: "http://127.0.0.1:61830/stream.mjpeg",
      deviceId: urn.endsWith(DUO) ? DUO : FLAT,
      ...(urn.endsWith(DUO)
        ? { display: { foldable: true, panels: PANELS, hingeAngle: null } }
        : {}),
    })),
  } as unknown as Registry;
  const app = express();
  app.use(createPreviewRouter(registry));
  return app;
}

beforeEach(() => {
  resolveLivePanelMock.mockReset();
});

describe("GET /preview/simulator-server/:udid on a foldable", () => {
  it("hands out the live panel's stream, resolved now, and says which source named it", async () => {
    resolveLivePanelMock.mockResolvedValue({ screen: 3, source: "ax-service" });
    const res = await request(makeApp()).get(`/simulator-server/${DUO}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      foldable: true,
      activeScreen: 3,
      panelSource: "ax-service",
      streamUrl: "http://127.0.0.1:61830/stream.mjpeg?screen=3",
    });
    expect(res.body).not.toHaveProperty("warning");
    expect(resolveLivePanelMock).toHaveBeenCalledWith(DUO);
  });

  it("falls back to the main screen and says why when nothing resolved the panel", async () => {
    resolveLivePanelMock.mockResolvedValue({
      screen: 1,
      source: "unknown",
      reason: "the accessibility service failed (no); CoreDevice failed (no)",
    });
    const res = await request(makeApp()).get(`/simulator-server/${DUO}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      foldable: true,
      activeScreen: 1,
      panelSource: "unknown",
      streamUrl: "http://127.0.0.1:61830/stream.mjpeg",
    });
    expect(res.body.warning).toContain("could not be resolved (the accessibility service failed");
    expect(res.body.warning).toContain("the preview shows screen 1 (cover panel, 1398x2034)");
  });

  it("names no panel for a device that is not foldable, and resolves nothing", async () => {
    const res = await request(makeApp()).get(`/simulator-server/${FLAT}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      udid: FLAT,
      apiUrl: "http://127.0.0.1:61830",
      streamUrl: "http://127.0.0.1:61830/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:61830/ws",
    });
    expect(resolveLivePanelMock).not.toHaveBeenCalled();
  });
});
