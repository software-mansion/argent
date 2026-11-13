import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import type { Registry } from "@argent/registry";

// Keep the update note out of these assertions (same approach as the other
// http-*.test.ts files): no update available, never suppressed.
vi.mock("../src/utils/update-checker", () => ({
  getUpdateState: vi.fn(() => ({
    updateAvailable: false,
    updateInstallable: false,
    installableVersion: null,
    latestVersion: null,
    latestPublishedAt: null,
    minReleaseAgeMs: 0,
    currentVersion: "1.0.0",
  })),
  isUpdateNoteSuppressed: vi.fn(() => false),
  suppressUpdateNote: vi.fn(),
}));

const FAILED_RUN = {
  e2eTest: "checkout",
  ok: false,
  passed: 2,
  failed: 1,
  skipped: 7,
  errored: 0,
  steps: [
    { index: 0, kind: "echo", status: "pass" },
    {
      index: 1,
      kind: "tool",
      tool: "await-ui-element",
      status: "fail",
      reason: "await-ui-element condition not met: no element matched the selector before timeout",
    },
  ],
};
const FAILED_RUN_REASON =
  'e2e test "checkout" failed: 2 passed, 1 failed, 0 errored (await-ui-element: ' +
  "await-ui-element condition not met: no element matched the selector before timeout)";

function stubRegistry(tools: Record<string, () => unknown>): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: Object.keys(tools) })),
    getTool: vi.fn((name: string) =>
      tools[name]
        ? {
            id: name,
            description: "A stub tool for testing",
            inputSchema: { type: "object", properties: {} },
            services: () => ({}),
            execute: async () => tools[name]!(),
          }
        : undefined
    ),
    invokeTool: vi.fn(async (name: string) => tools[name]!()),
  } as unknown as Registry;
}

describe("HTTP failure reported in a tool's result", () => {
  let handle: HttpAppHandle;

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("sends a failed e2e-execute run's reason beside its report", async () => {
    handle = createHttpApp(stubRegistry({ "e2e-execute": () => structuredClone(FAILED_RUN) }));
    const res = await supertest(handle.app).post("/tools/e2e-execute").send({});
    expect(res.status).toBe(200);
    expect(res.body.failure).toBe(FAILED_RUN_REASON);
    expect(res.body.data).toEqual(FAILED_RUN);
  });

  it("sends it on the NDJSON stream path too", async () => {
    handle = createHttpApp(stubRegistry({ "e2e-execute": () => structuredClone(FAILED_RUN) }));
    const res = await supertest(handle.app)
      .post("/tools/e2e-execute")
      .set("Accept", "application/x-ndjson")
      .send({});
    const result = res.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; failure?: string })
      .find((l) => l.event === "result");
    expect(result?.failure).toBe(FAILED_RUN_REASON);
  });

  it("sends an unmet await-ui-element's reason", async () => {
    handle = createHttpApp(
      stubRegistry({
        "await-ui-element": () => ({ success: false, elapsed: 800, note: "no element matched" }),
      })
    );
    const res = await supertest(handle.app).post("/tools/await-ui-element").send({});
    expect(res.body.failure).toBe("await-ui-element condition not met: no element matched");
  });

  it("sends no failure for a status tool whose answer is a disconnected state", async () => {
    handle = createHttpApp(
      stubRegistry({
        "debugger-status": () => ({
          status: "not_connected",
          reason: "metro_not_running",
          detail: "nothing on 8081",
          guidance: "start Metro",
        }),
      })
    );
    const res = await supertest(handle.app).post("/tools/debugger-status").send({});
    expect(res.body).not.toHaveProperty("failure");
  });

  it("sends no failure for a passing run", async () => {
    handle = createHttpApp(
      stubRegistry({ "e2e-execute": () => ({ ...FAILED_RUN, ok: true, failed: 0 }) })
    );
    const res = await supertest(handle.app).post("/tools/e2e-execute").send({});
    expect(res.body).not.toHaveProperty("failure");
  });

  it("sends no failure for `ok: false` from a tool that does not report a verdict", async () => {
    handle = createHttpApp(stubRegistry({ "test-tool": () => ({ ok: false }) }));
    const res = await supertest(handle.app).post("/tools/test-tool").send({});
    expect(res.body).not.toHaveProperty("failure");
    expect(res.body.data).toEqual({ ok: false });
  });
});
