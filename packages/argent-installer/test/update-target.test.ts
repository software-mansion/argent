import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";

vi.mock("node:https");

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({ exec: mockExec }));

import {
  detectMinReleaseAgeMs,
  parseBeforeAgeMs,
  parseYarnAgeGateMs,
  pickInstallableTarget,
  resolveInstallableUpdateTarget,
} from "../src/update-target.js";

const NOW = new Date("2026-06-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

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

function packumentMulti(latest: string, times: Record<string, string>): string {
  return JSON.stringify({ "dist-tags": { latest }, "time": times });
}

function stubExec(byCommand: Record<string, string>) {
  mockExec.mockImplementation((cmd: string, _opts: unknown, cb: unknown) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    if (cmd in byCommand) {
      callback(null, byCommand[cmd]!, "");
    } else {
      callback(new Error("command not found"), "", "");
    }
  });
}

describe("update-target helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockExec.mockReset();
    delete process.env.ARGENT_MIN_RELEASE_AGE_DAYS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.ARGENT_MIN_RELEASE_AGE_DAYS;
  });

  it("parses npm's effective `before` cutoff into an equivalent age", () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();
    expect(parseBeforeAgeMs(twoDaysAgo, NOW.getTime())).toBe(2 * DAY_MS);
  });

  it("parses Yarn's quoted duration syntax", () => {
    expect(parseYarnAgeGateMs('"1d"')).toBe(DAY_MS);
    expect(parseYarnAgeGateMs("90")).toBe(90 * 60 * 1000);
  });

  it("detects npm's gate from the effective `before` config", async () => {
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * DAY_MS).toISOString();
    stubExec({ "npm config get before": sevenDaysAgo });
    expect(await detectMinReleaseAgeMs("npm")).toBe(7 * DAY_MS);
  });

  it("picks the newest eligible version when the latest publish is still held", () => {
    const oneDayAgo = new Date(NOW.getTime() - DAY_MS).toISOString();
    const tenDaysAgo = new Date(NOW.getTime() - 10 * DAY_MS).toISOString();
    const target = pickInstallableTarget(
      { version: "99.0.0", publishedAt: oneDayAgo },
      { "98.0.0": tenDaysAgo, "99.0.0": oneDayAgo },
      "1.0.0",
      7 * DAY_MS
    );
    expect(target?.version).toBe("98.0.0");
  });

  it("resolves the newest installable target for the selected package manager", async () => {
    const oneDayAgo = new Date(NOW.getTime() - DAY_MS).toISOString();
    const tenDaysAgo = new Date(NOW.getTime() - 10 * DAY_MS).toISOString();
    stubExec({ "npm config get before": new Date(NOW.getTime() - 7 * DAY_MS).toISOString() });
    mockResponseBody(
      200,
      packumentMulti("99.0.0", {
        "98.0.0": tenDaysAgo,
        "99.0.0": oneDayAgo,
      })
    );

    await expect(resolveInstallableUpdateTarget("npm", "1.0.0")).resolves.toMatchObject({
      latestVersion: "99.0.0",
      targetVersion: "98.0.0",
      minReleaseAgeMs: 7 * DAY_MS,
    });
  });
});
