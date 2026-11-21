import { describe, it, expect, vi, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  CALLER_DEADLINE_HEADER,
  FAILURE_CODES,
  Registry,
  getFailureSignal,
  type ToolDefinition,
} from "@argent/registry";
import { createHttpApp, type HttpAppHandle } from "../src/http";

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

const CALLER_DEADLINE = Symbol.for("argent.caller_deadline");

describe(`HTTP ${CALLER_DEADLINE_HEADER} header`, () => {
  let handle: HttpAppHandle;
  let server: http.Server;

  afterEach(async () => {
    handle?.dispose();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  /**
   * Serves a tool that writes `lines` progress lines `lineGapMs` apart, then
   * waits for its signal. `failure` resolves with the abort reason the tool
   * saw and the class of its failure.
   */
  async function serve({ lines = 0, lineGapMs = 0 } = {}) {
    const registry = new Registry();
    let seen: unknown;
    registry.registerTool({
      id: "wait-tool",
      description: "stub",
      zodSchema: z.object({}),
      services: () => ({}),
      execute: async (_services, _params, ctx) => {
        const signal = ctx!.signal!;
        const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve));
        for (let line = 0; line < lines; line++) {
          if (line > 0) await new Promise((resolve) => setTimeout(resolve, lineGapMs));
          ctx!.emitProgress?.({ line });
        }
        await aborted;
        seen = signal.reason;
        signal.throwIfAborted();
      },
    } as ToolDefinition<Record<string, never>>);
    const failed = new Promise<Error>((resolve) =>
      registry.events.on("toolFailed", (_toolId, _id, error) => resolve(error))
    );
    handle = createHttpApp(registry);
    server = http.createServer(handle.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const failure = failed.then((error) => ({
      reason: seen as DOMException,
      signal: getFailureSignal(error),
    }));
    return { port, url: `http://127.0.0.1:${port}/tools/wait-tool`, failure };
  }

  /** Sends a call and hangs up after `hangUpMs`. */
  async function hangUp(hangUpMs: number, headers: Record<string, string> = {}) {
    const { url, failure } = await serve();

    await expect(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
        signal: AbortSignal.timeout(hangUpMs),
      })
    ).rejects.toThrow();

    return failure;
  }

  /** Streams a call whose tool writes two lines 2 s apart, and hangs up `afterMs` after the second. */
  async function hangUpAfterLines(afterMs: number) {
    const { url, failure } = await serve({ lines: 2, lineGapMs: 2_000 });
    const controller = new AbortController();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/x-ndjson",
        [CALLER_DEADLINE_HEADER]: "2600",
      },
      body: "{}",
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (let received = 0; received < 2;) {
      const { value } = await reader.read();
      received += decoder.decode(value).split("\n").length - 1;
    }
    await new Promise((resolve) => setTimeout(resolve, afterMs));
    controller.abort();

    return failure;
  }

  it("aborts the tool with a deadline reason when the caller hangs up at its deadline", async () => {
    // Within the slack before the declared deadline.
    const { reason, signal } = await hangUp(500, { [CALLER_DEADLINE_HEADER]: "2200" });

    expect((reason as unknown as Record<symbol, unknown>)[CALLER_DEADLINE]).toBe(true);
    expect(reason.name).toBe("AbortError");
    expect(reason.message).toContain("aborted");
    expect(signal?.error_code).toBe(FAILURE_CODES.REGISTRY_TOOL_CALL_TIMED_OUT);
  });

  it.each([
    ["well before the declared deadline", { [CALLER_DEADLINE_HEADER]: "5000" }],
    ["without the header", {}],
    ["with a deadline of 0", { [CALLER_DEADLINE_HEADER]: "0" }],
  ])("aborts the tool as a cancel when the caller hangs up %s", async (_label, headers) => {
    const { reason, signal } = await hangUp(100, headers);

    expect(CALLER_DEADLINE in reason).toBe(false);
    expect(reason.name).toBe("AbortError");
    expect(signal?.error_code).toBe(FAILURE_CODES.REGISTRY_TOOL_CALL_CANCELLED);
  });

  it("counts the time the caller spends sending the body toward its deadline", async () => {
    const { port, failure } = await serve();
    // The body takes 2.5 s, longer than the slack, and the caller hangs up at
    // the deadline it declared, counted from its send.
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/tools/wait-tool",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "7",
        [CALLER_DEADLINE_HEADER]: "3000",
      },
    });
    req.on("error", () => {});
    setTimeout(() => req.destroy(), 3_000);
    req.write("{");
    for (let chunk = 0; chunk < 5; chunk++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      req.write(" ");
    }
    req.end("}");

    const { signal } = await failure;
    expect(signal?.error_code).toBe(FAILURE_CODES.REGISTRY_TOOL_CALL_TIMED_OUT);
  }, 10_000);

  it("counts a streamed call's deadline from the last line it wrote", async () => {
    const { signal } = await hangUpAfterLines(2_600);

    expect(signal?.error_code).toBe(FAILURE_CODES.REGISTRY_TOOL_CALL_TIMED_OUT);
  }, 10_000);

  it("aborts a streamed call as a cancel when the caller hangs up soon after a line", async () => {
    // At the deadline counted from the request, well before it counted from the last line.
    const { reason, signal } = await hangUpAfterLines(100);

    expect(CALLER_DEADLINE in reason).toBe(false);
    expect(signal?.error_code).toBe(FAILURE_CODES.REGISTRY_TOOL_CALL_CANCELLED);
  }, 10_000);
});
