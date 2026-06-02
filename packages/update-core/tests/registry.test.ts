import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";

vi.mock("node:https");

import { fetchRegistryInfo } from "../src/registry";

function createMockResponse(statusCode: number, body: string) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    setEncoding: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };
  res.statusCode = statusCode;
  res.setEncoding = vi.fn();
  res.resume = vi.fn();

  process.nextTick(() => {
    res.emit("data", body);
    res.emit("end");
  });

  return res;
}

function mockResponseBody(statusCode: number, body: string) {
  const mockGet = vi.mocked(https.get);
  mockGet.mockImplementation((_url: unknown, _opts: unknown, cb: unknown) => {
    const callback = cb as (res: ReturnType<typeof createMockResponse>) => void;
    callback(createMockResponse(statusCode, body));
    return new EventEmitter() as ReturnType<typeof https.get>;
  });
  return mockGet;
}

const URL = "https://registry.npmjs.org/@swmansion/argent";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRegistryInfo", () => {
  it("parses the packument into latest + times", async () => {
    mockResponseBody(
      200,
      JSON.stringify({
        "dist-tags": { latest: "2.0.0" },
        "time": { "1.0.0": "2026-01-01T00:00:00Z", "2.0.0": "2026-05-01T00:00:00Z" },
      })
    );

    const info = await fetchRegistryInfo(URL);
    expect(info?.latest).toEqual({ version: "2.0.0", publishedAt: "2026-05-01T00:00:00Z" });
    expect(info?.times["1.0.0"]).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null when the registry responds with a non-200 status", async () => {
    mockResponseBody(503, "");
    expect(await fetchRegistryInfo(URL)).toBeNull();
  });

  it("returns null when the body has no latest dist-tag", async () => {
    mockResponseBody(200, JSON.stringify({ time: {} }));
    expect(await fetchRegistryInfo(URL)).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    mockResponseBody(200, "not json");
    expect(await fetchRegistryInfo(URL)).toBeNull();
  });
});
