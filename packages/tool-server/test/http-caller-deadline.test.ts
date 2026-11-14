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
   * Sends a call to a tool that waits for its signal, hangs up after
   * `hangUpMs`, and resolves with the abort reason the tool saw and the class
   * of its failure.
   */
  async function hangUp(hangUpMs: number, headers: Record<string, string> = {}) {
    const registry = new Registry();
    let seen: unknown;
    registry.registerTool({
      id: "wait-tool",
      description: "stub",
      zodSchema: z.object({}),
      services: () => ({}),
      execute: async (_services, _params, ctx) => {
        const signal = ctx!.signal!;
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
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

    await expect(
      fetch(`http://127.0.0.1:${port}/tools/wait-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
        signal: AbortSignal.timeout(hangUpMs),
      })
    ).rejects.toThrow();

    const error = await failed;
    return { reason: seen as DOMException, signal: getFailureSignal(error) };
  }

  it("aborts the tool with a deadline reason when the caller hangs up at its deadline", async () => {
    // Within the slack before the declared deadline.
    const { reason, signal } = await hangUp(300, { [CALLER_DEADLINE_HEADER]: "1100" });

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
});
