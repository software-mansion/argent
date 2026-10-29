import { invokeSubTool } from "../src/utils/sub-invoke";
import {
  registerActiveScreenRecording,
  clearActiveScreenRecording,
} from "../src/utils/screen-recording-reminder";
import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import { ensureDeps } from "../src/utils/check-deps";
import { InvalidToolInputError } from "../src/utils/capability";
import type { AddressInfo } from "node:net";
import type { Response } from "supertest";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import {
  FAILURE_CODES,
  FailureError,
  ToolExecutionError,
  Registry,
  type InvokeToolOptions,
  TypedEventEmitter,
} from "@argent/registry";

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(async () => {}),
}));

// Streaming rides the same response path as the update note — pin the checker
// to "no update" so result lines stay minimal and deterministic.
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

function stubRegistry(
  impl: (options: InvokeToolOptions | undefined) => Promise<unknown>
): Registry {
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["test-tool"] })),
    getTool: vi.fn((name: string) =>
      name === "test-tool"
        ? {
            id: "test-tool",
            description: "A stub tool for testing",
            inputSchema: { type: "object", properties: {} },
            services: () => ({}),
            execute: async () => ({ ok: true }),
          }
        : undefined
    ),
    invokeTool: vi.fn((_name: string, _params: unknown, options?: InvokeToolOptions) =>
      impl(options)
    ),
  } as unknown as Registry;
}

/** Collect a non-JSON response body as raw text (supertest only parses JSON). */
function collectText(res: Response, cb: (err: Error | null, body: string) => void): void {
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => (text += chunk));
  res.on("end", () => cb(null, text));
}

function parseLines(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("HTTP NDJSON streaming (Accept: application/x-ndjson)", () => {
  let handle: HttpAppHandle;

  afterEach(() => {
    handle?.dispose();
    vi.clearAllMocks();
  });

  it("rejects tool calls after shutdown begins", async () => {
    const registry = stubRegistry(async () => ({ ok: true }));
    handle = createHttpApp(registry);
    handle.dispose();
    const response = await supertest(handle.app).post("/tools/test-tool").send({}).expect(503);
    expect(response.body.error).toContain("shutting down");
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects before tool lookup, validation or failure telemetry after shutdown", async () => {
    const registry = stubRegistry(async () => ({ ok: true }));
    const recordFailure = vi.fn();
    handle = createHttpApp(registry, { recordFailure });
    handle.dispose();
    const response = await supertest(handle.app).post("/tools/missing").send({}).expect(503);
    expect(response.body.error_code).toBe(FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN);
    expect(registry.getTool).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("reports shutdown health and recording recovery without promising a retry", async () => {
    const registry = stubRegistry(async () => ({ ok: true }));
    handle = createHttpApp(registry);
    handle.dispose();
    const health = await supertest(handle.app).get("/tools").expect(503);
    expect(health.body.error_code).toBe(FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN);
    const stop = await supertest(handle.app)
      .post("/tools/screen-recording-stop")
      .send({ udid: "device", outputFile: "/server/recording.mp4" })
      .expect(503);
    expect(stop.body.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN);
    expect(stop.body.error).toContain("/server/recording.mp4");
    expect(stop.body.error).toContain("restart loses result retrieval state");
    expect(stop.body.error).not.toContain("Retry after");
  });

  it.each([false, true])(
    "reports an interrupted recording stop before shutdown closes the connection (stream: %s)",
    async (stream) => {
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      registerActiveScreenRecording("device", Date.now(), 60, "/server/recording.mp4");
      let completed = false;
      let signal: AbortSignal | undefined;
      const registry = stubRegistry(async (options) => {
        signal = options?.signal;
        options?.onRecordingOutput?.("device", "/server/recording.mp4");
        enter();
        clearActiveScreenRecording("device");
        await pending;
        completed = true;
        return { video: "saved.mp4" };
      });
      const def = registry.getTool("test-tool")!;
      vi.mocked(registry.getTool).mockReturnValue({
        ...def,
        id: "screen-recording-stop",
        longRunning: true,
      });
      handle = createHttpApp(registry);
      let request = supertest(handle.app)
        .post("/tools/screen-recording-stop")
        .send({ udid: "device" });
      if (stream)
        request = request.set("Accept", "application/x-ndjson").buffer(true).parse(collectText);
      const response = request.then((res) => res);
      await entered;
      handle.dispose();
      const admission = await supertest(handle.app)
        .post("/tools/screen-recording-stop")
        .send({ udid: "device" })
        .expect(503);
      expect(admission.body.error).toContain("/server/recording.mp4");
      const discovery = await supertest(handle.app)
        .get("/tools")
        .set(
          "X-Argent-Call",
          encodeURIComponent(JSON.stringify({ tool: "screen-recording-stop", udid: "device" }))
        )
        .expect(503);
      expect(discovery.body.error).toContain("/server/recording.mp4");
      const result = await response;
      expect(result.status).toBe(stream ? 200 : 503);
      const body = stream ? parseLines(result.body as string)[0] : result.body;
      expect(body.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN);
      expect(body.error).toContain("/server/recording.mp4");
      expect(body.error).toContain("does not confirm a saved video");
      expect(body.error).toContain("restart loses result retrieval state");
      if (stream) expect(body.event).toBe("error");
      expect(completed).toBe(false);
      expect(signal?.aborted).toBe(true);
      finish();
      await vi.waitFor(() => expect(completed).toBe(true));
    }
  );

  it("delivers a stop that finishes inside the shutdown grace", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    handle = createHttpApp(
      stubRegistry(async () => {
        enter();
        await pending;
        return { video: "saved.mp4" };
      })
    );
    const response = supertest(handle.app)
      .post("/tools/test-tool")
      .send({})
      .then((res) => res);
    await entered;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      handle.dispose();
      await vi.advanceTimersByTimeAsync(200);
      finish();
      expect((await response).body).toEqual({ data: { video: "saved.mp4" } });
    } finally {
      finish();
      vi.useRealTimers();
    }
  });

  it("keeps admission recovery paths after recording teardown clears reminders", async () => {
    registerActiveScreenRecording("device", Date.now(), 60, "/server/original.mp4");
    handle = createHttpApp(stubRegistry(async () => ({})));
    handle.dispose();
    clearActiveScreenRecording("device");
    const listing = await supertest(handle.app)
      .get("/tools")
      .set(
        "X-Argent-Call",
        encodeURIComponent(JSON.stringify({ tool: "screen-recording-stop", udid: "device" }))
      )
      .expect(503);
    expect(listing.body.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN);
    expect(listing.body.error).toContain("/server/original.mp4");
    const response = await supertest(handle.app)
      .post("/tools/screen-recording-stop")
      .send({ udid: "device" })
      .expect(503);
    expect(response.body.error).toContain("/server/original.mp4");
    expect(response.body.error).toContain("This call was not started");
  });

  it("scopes discovery and stop admission paths to the requested device", async () => {
    registerActiveScreenRecording("A", Date.now(), 60, "/server/a.mp4");
    registerActiveScreenRecording("B", Date.now(), 60, "/server/b.mp4");
    handle = createHttpApp(stubRegistry(async () => ({})));
    handle.dispose();
    clearActiveScreenRecording("A");
    clearActiveScreenRecording("B");
    for (const tool of ["screen-recording-stop", "screenshot"]) {
      for (const udid of ["A", "B", "C"]) {
        for (const method of ["discovery", "post"]) {
          const request =
            method === "discovery"
              ? supertest(handle.app)
                  .get("/tools")
                  .set("X-Argent-Call", encodeURIComponent(JSON.stringify({ tool, udid })))
              : supertest(handle.app).post(`/tools/${tool}`).send({ udid });
          const response = await request.expect(503);
          const recording = tool === "screen-recording-stop";
          expect(response.body.error_code).toBe(
            recording
              ? FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN
              : FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN
          );
          for (const [device, file] of [
            ["A", "/server/a.mp4"],
            ["B", "/server/b.mp4"],
          ]) {
            expect(response.body.error.includes(file)).toBe(recording && udid === device);
          }
          if (!recording) expect(response.body.error).toContain("Reconnect after the server exits");
        }
      }
    }
    const listing = await supertest(handle.app).get("/tools").expect(503);
    expect(listing.body.error).not.toContain(".mp4");
    expect(listing.body.error).toContain("Reconnect after the server exits");
  });

  it.each(["resolve", "invoke"])(
    "normalizes an admitted call interrupted at registry %s",
    async (operation) => {
      const registry = new Registry();
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let resume!: () => void;
      const pending = new Promise<void>((resolve) => {
        resume = resolve;
      });
      registry.registerTool({
        id: "lazy",
        services: () => ({}),
        execute: async () => {
          enter();
          await pending;
          return operation === "resolve"
            ? registry.resolveService("Service:only")
            : registry.invokeTool("missing");
        },
      });
      handle = createHttpApp(registry);
      const response = supertest(handle.app)
        .post("/tools/lazy")
        .send({})
        .then((res) => res);
      await entered;
      registry.beginShutdown();
      handle.dispose();
      resume();
      const result = await response;
      expect(result.status).toBe(503);
      expect(result.body.error_code).toBe(FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN);
      expect(result.body.error).toContain("The tool may have run");
      expect(result.body.error).toContain("Check its effect before running it again");
      expect(result.body.error).not.toContain("This call was not started");
    }
  );

  it.each(["sequence", "flow", "flow-fold", "flow-tap", "flow-launch", "flow-snapshot"])(
    "propagates shutdown out of a real %s orchestrator",
    async (kind) => {
      const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const registry = new Registry();
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      registry.registerTool({
        id: "keyboard",
        services: () => ({}),
        execute: async () => {
          enter();
          await pending;
          return {};
        },
      });
      const directory = await mkdtemp(join(tmpdir(), "argent-http-flow-"));
      try {
        let name: string;
        let args: Record<string, unknown>;
        if (kind === "sequence") {
          const { createRunSequenceTool } = await import("../src/tools/run-sequence");
          registry.registerTool(createRunSequenceTool(registry));
          name = "run-sequence";
          args = {
            udid: "emulator-5554",
            steps: [0, 1].map(() => ({ tool: "keyboard", args: { text: "test" }, delayMs: 0 })),
          };
        } else {
          const { createRunFlowTool } = await import("../src/tools/flows/flow-run");
          const { serializeFlow } = await import("../src/tools/flows/flow-utils");
          await mkdir(join(directory, ".argent", "flows"), { recursive: true });
          const file = join(directory, ".argent", "flows", "test.yaml");
          await writeFile(
            file,
            serializeFlow({
              executionPrerequisite: "",
              steps: [
                { kind: "tool", name: "keyboard", args: { text: "test" } },
                kind === "flow-fold"
                  ? { kind: "fold", posture: "open" }
                  : kind === "flow-tap"
                    ? { kind: "tap", x: 0.5, y: 0.5 }
                    : kind === "flow-launch"
                      ? { kind: "launch", app: "com.example.test" }
                      : kind === "flow-snapshot"
                        ? { kind: "snapshot", name: "test", maxMismatch: 0.5 }
                        : { kind: "tool", name: "keyboard", args: { text: "test" } },
              ],
            })
          );
          const tool = createRunFlowTool(registry);
          registry.registerTool(tool);
          name = tool.id;
          args = { project_root: directory, name: "test", device: "emulator-5554" };
        }
        handle = createHttpApp(registry);
        const response = supertest(handle.app)
          .post(`/tools/${name}`)
          .send(args)
          .then((res) => res);
        await Promise.race([
          entered,
          response.then((res) => {
            throw new Error(
              `Orchestrator did not enter its first step: ${JSON.stringify(res.body)}`
            );
          }),
        ]);
        registry.beginShutdown();
        handle.dispose();
        finish();
        const result = await response;
        expect(result.status).toBe(503);
        expect(result.body.error_code).toBe(FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN);
        expect(result.body.error).toContain("The tool may have run");
        expect(result.body).not.toHaveProperty("data");
      } finally {
        finish();
        await registry.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it("normalizes a service terminated during shutdown initialization", async () => {
    const registry = new Registry();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registry.registerBlueprint({
      namespace: "Delayed",
      getURN: () => "Delayed:device",
      factory: async () => {
        enter();
        await pending;
        return { api: {}, events: new TypedEventEmitter(), dispose: async () => {} };
      },
    });
    registry.registerTool({
      id: "describe",
      services: () => ({ delayed: "Delayed:device" }),
      execute: async () => ({}),
    });
    handle = createHttpApp(registry);
    const response = supertest(handle.app)
      .post("/tools/describe")
      .send({})
      .then((res) => res);
    await entered;
    registry.beginShutdown();
    handle.dispose();
    const disposal = registry.dispose();
    finish();
    try {
      const result = await response;
      expect(result.status).toBe(503);
      expect(result.body.error_code).toBe(FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN);
      expect(result.body.error).toContain("The tool may have run");
    } finally {
      await disposal;
    }
  });

  it.each(["screen-recording-start", "screen-recording-stop"])(
    "preserves nested %s context while a flow is interrupted",
    async (tool) => {
      const registry = new Registry();
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let signal: AbortSignal | undefined;
      let completed = false;
      const subsequentWork = vi.fn();
      let flowCompleted = false;
      registry.registerTool({
        id: tool,
        services: () => ({}),
        execute: async (_services, _args, ctx) => {
          signal = ctx?.signal;
          ctx?.onRecordingOutput?.("device", "/server/nested.mp4");
          enter();
          await pending;
          completed = true;
          return { video: "saved.mp4" };
        },
      });
      registry.registerTool({
        id: "e2e-execute",
        longRunning: true,
        services: () => ({}),
        execute: async (_services, _args, ctx) => {
          const result = await invokeSubTool(registry, ctx, tool, {});
          try {
            ctx?.signal?.throwIfAborted();
            subsequentWork();
            return result;
          } finally {
            flowCompleted = true;
          }
        },
      });
      handle = createHttpApp(registry);
      const response = supertest(handle.app)
        .post("/tools/e2e-execute")
        .set("Accept", "application/x-ndjson")
        .send({})
        .buffer(true)
        .parse(collectText)
        .then((res) => res);
      await entered;
      registry.beginShutdown();
      handle.dispose();
      const result = parseLines((await response).body as string)[0];
      expect(result.error_code).toBe(FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN);
      expect(result.error).toContain("/server/nested.mp4");
      expect(result.error).toContain("The tool may have run");
      expect(signal?.aborted).toBe(true);
      expect(completed).toBe(false);
      finish();
      await vi.waitFor(() => expect(flowCompleted).toBe(true));
      expect(completed).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(subsequentWork).not.toHaveBeenCalled();
    }
  );

  it("continues healthy calls after a nested recording output is reported", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "screen-recording-stop",
      services: () => ({}),
      execute: async (_services, _args, ctx) => {
        ctx?.onRecordingOutput?.("device", "/server/healthy.mp4");
        return {};
      },
    });
    const laterWork = vi.fn();
    registry.registerTool({
      id: "e2e-execute",
      services: () => ({}),
      execute: async (_services, _args, ctx) => {
        await invokeSubTool(registry, ctx, "screen-recording-stop", {});
        ctx?.signal?.throwIfAborted();
        laterWork();
        return { ok: true };
      },
    });
    handle = createHttpApp(registry);
    const result = await supertest(handle.app).post("/tools/e2e-execute").send({}).expect(200);
    expect(result.body.data).toEqual({ ok: true });
    expect(laterWork).toHaveBeenCalledOnce();
  });

  it("waits the full shutdown grace and aborts unfinished non-recording calls", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    handle = createHttpApp(
      stubRegistry(async (options) => {
        signal = options?.signal;
        enter();
        await pending;
        return { ok: true };
      })
    );
    let delivered = false;
    const response = supertest(handle.app)
      .post("/tools/test-tool")
      .send({ outputFile: "/server/profile.cpuprofile" })
      .then((res) => {
        delivered = true;
        return res;
      });
    await entered;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      handle.dispose();
      await vi.advanceTimersByTimeAsync(1499);
      expect(delivered).toBe(false);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await response;
      expect(result.status).toBe(503);
      expect(result.body.error_code).toBe(FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN);
      expect(result.body.error).not.toContain("Recording finalization");
      expect(result.body.error).toContain("The tool may have run");
      expect(result.body.error).not.toContain("This call was not started");
      expect(signal?.aborted).toBe(true);
    } finally {
      finish();
      vi.useRealTimers();
    }
  });

  it("aborts later flow work after a completed stop while retaining its output path", async () => {
    const registry = new Registry();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    registry.registerTool({
      id: "screen-recording-stop",
      services: () => ({}),
      execute: async (_services, _args, ctx) => {
        ctx?.onRecordingOutput?.("device", "/server/previous.mp4");
        return { video: "saved.mp4" };
      },
    });
    registry.registerTool({
      id: "e2e-execute",
      services: () => ({}),
      execute: async (_services, _args, ctx) => {
        signal = ctx?.signal;
        await invokeSubTool(registry, ctx, "screen-recording-stop", {});
        enter();
        await pending;
        return { ok: true };
      },
    });
    handle = createHttpApp(registry);
    const response = supertest(handle.app)
      .post("/tools/e2e-execute")
      .send({})
      .then((res) => res);
    await entered;
    registerActiveScreenRecording("device", Date.now(), 60, "/server/current.mp4");
    try {
      registry.beginShutdown();
      handle.dispose();
      clearActiveScreenRecording("device");
      const listing = await supertest(handle.app)
        .get("/tools")
        .set(
          "X-Argent-Call",
          encodeURIComponent(JSON.stringify({ tool: "screen-recording-stop", udid: "device" }))
        )
        .expect(503);
      expect(listing.body.error).toContain("/server/current.mp4");
      expect(listing.body.error).not.toContain("/server/previous.mp4");
      const result = await response;
      expect(result.body.error).toContain("/server/previous.mp4");
      expect(signal?.aborted).toBe(true);
    } finally {
      finish();
      clearActiveScreenRecording("device");
    }
  });

  it("streams each emitProgress event as a line, then the terminal result", async () => {
    const registry = stubRegistry(async (options) => {
      options?.emitProgress?.({ index: 0, status: "pass" });
      options?.emitProgress?.({ index: 1, status: "fail" });
      return { ok: false, steps: 2 };
    });
    handle = createHttpApp(registry);

    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({})
      .buffer(true)
      .parse(collectText)
      .expect(200);

    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const lines = parseLines(res.body as string);
    expect(lines).toEqual([
      { event: "progress", data: { index: 0, status: "pass" } },
      { event: "progress", data: { index: 1, status: "fail" } },
      { event: "result", data: { ok: false, steps: 2 } },
    ]);
  });

  it("ignores late progress after a streamed shutdown error ends the response", async () => {
    let progress: InvokeToolOptions["emitProgress"];
    const attemptedAfterEnd = vi.fn();
    handle = createHttpApp(
      stubRegistry(async (options) => {
        progress = options?.emitProgress;
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true })
        );
        return {};
      })
    );
    const server = handle.app.listen(0, "127.0.0.1");
    server.on("request", (_req, res) => {
      const write = res.write.bind(res);
      res.write = ((...args: Parameters<typeof res.write>) => {
        if (res.writableEnded) {
          attemptedAfterEnd();
          return false;
        }
        return write(...args);
      }) as typeof res.write;
      res.once("finish", () => {
        expect(res.destroyed).toBe(false);
        progress?.({ status: "skip", reason: "run aborted" });
      });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/tools/test-tool`, {
        method: "POST",
        headers: { "Accept": "application/x-ndjson", "Content-Type": "application/json" },
        body: "{}",
      });
      handle.dispose();
      const lines = parseLines(await response.text());
      expect(lines).toEqual([
        expect.objectContaining({
          event: "error",
          error_code: FAILURE_CODES.HTTP_SERVER_SHUTTING_DOWN,
        }),
      ]);
      expect(attemptedAfterEnd).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends headers before a silent tool finishes and keeps its body active past five minutes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    handle = createHttpApp(
      stubRegistry(async () => {
        await pending;
        return { ok: true };
      })
    );
    const server = handle.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/tools/test-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson" },
        body: "{}",
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let received = false;
      const first = reader.read().then((chunk) => {
        received = true;
        return chunk;
      });
      await vi.advanceTimersByTimeAsync(14_999);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(received).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(new TextDecoder().decode((await first).value)).toBe("\n");
      for (let i = 0; i < 20; i++) {
        const next = reader.read();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(new TextDecoder().decode((await next).value)).toBe("\n");
      }
      finish();
      let result = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        result += new TextDecoder().decode(value);
      }
      expect(JSON.parse(result.trim())).toEqual({ event: "result", data: { ok: true } });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does NOT pass emitProgress (nor stream) without the Accept header", async () => {
    let seenOptions: InvokeToolOptions | undefined;
    const registry = stubRegistry(async (options) => {
      seenOptions = options;
      return { ok: true };
    });
    handle = createHttpApp(registry);

    const res = await supertest(handle.app).post("/tools/test-tool").send({}).expect(200);

    expect(seenOptions?.emitProgress).toBeUndefined();
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ data: { ok: true } });
  });

  it("keeps a long buffered response as JSON without keepalive bytes", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    handle = createHttpApp(
      stubRegistry(async () => {
        enter();
        await pending;
        return { ok: true };
      })
    );
    const server = handle.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { port } = server.address() as AddressInfo;
      const response = fetch(`http://127.0.0.1:${port}/tools/test-tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5_000),
      });
      void response.catch(() => {});
      await entered;
      await vi.advanceTimersByTimeAsync(16_000);
      finish();
      const result = await response;
      expect(result.headers.get("Content-Type")).toContain("application/json");
      expect(await result.json()).toEqual({ data: { ok: true } });
    } finally {
      finish();
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a call whose preflight overlaps shutdown", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(ensureDeps).mockImplementationOnce(async () => {
      enter();
      await pending;
    });
    const registry = stubRegistry(async () => ({ ok: true }));
    const def = registry.getTool("test-tool")!;
    vi.mocked(registry.getTool).mockReturnValue({ ...def, requires: ["adb"], longRunning: true });
    const releaseInvocation = vi.fn();
    const recordInvocation = vi.fn(() => releaseInvocation);
    handle = createHttpApp(registry, { idleTimeoutMs: 60_000, recordInvocation });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const response = supertest(handle.app)
      .post("/tools/test-tool")
      .set("x-argent-ai-client", "codex")
      .send({})
      .then((res) => res);
    await entered;
    handle.dispose();
    finish();
    try {
      expect((await response).status).toBe(503);
      expect(registry.invokeTool).not.toHaveBeenCalled();
      expect(recordInvocation).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a wrapped input rejection identical on buffered and streamed paths", async () => {
    const input = new InvalidToolInputError("Use text or key, not both.");
    handle = createHttpApp(
      stubRegistry(async () => {
        throw new ToolExecutionError("test-tool", input.message, { cause: input });
      })
    );
    const buffered = await supertest(handle.app).post("/tools/test-tool").send({}).expect(400);
    const streamed = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({})
      .buffer(true)
      .parse(collectText)
      .expect(200);
    const [terminal] = parseLines(streamed.body as string);
    expect(terminal).toMatchObject({ event: "error", ...buffered.body });
    expect(terminal.error).toBe(input.message);
  });

  it("delivers a tool failure as an in-band terminal error line", async () => {
    const registry = stubRegistry(async (options) => {
      options?.emitProgress?.({ index: 0, status: "pass" });
      throw new Error("device went away");
    });
    handle = createHttpApp(registry);

    // Headers are already on the wire when the tool fails, so the status stays
    // 200 and the error rides the stream's terminal line.
    const res = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({})
      .buffer(true)
      .parse(collectText)
      .expect(200);

    const lines = parseLines(res.body as string);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ event: "progress", data: { index: 0, status: "pass" } });
    expect(lines[1].event).toBe("error");
    expect(String(lines[1].error)).toContain("device went away");
  });

  it("carries the failure signal on the terminal error line and the buffered 500", async () => {
    const registry = stubRegistry(async () => {
      throw new FailureError("flow file is not valid YAML", {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_file_parse",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    });
    handle = createHttpApp(registry);

    const streamed = await supertest(handle.app)
      .post("/tools/test-tool")
      .set("Accept", "application/x-ndjson")
      .send({})
      .buffer(true)
      .parse(collectText)
      .expect(200);
    const [line] = parseLines(streamed.body as string);
    expect(line).toEqual({
      event: "error",
      error: "flow file is not valid YAML",
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      error_kind: "validation",
    });

    const buffered = await supertest(handle.app).post("/tools/test-tool").send({}).expect(500);
    expect(buffered.body).toEqual({
      error: "flow file is not valid YAML",
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      error_kind: "validation",
    });
  });

  it("keeps plain-JSON status codes for failures before the invoke (unknown tool)", async () => {
    handle = createHttpApp(stubRegistry(async () => ({ ok: true })));

    // The 404 gate fires before the response commits to streaming.
    const res = await supertest(handle.app)
      .post("/tools/nope")
      .set("Accept", "application/x-ndjson")
      .send({})
      .expect(404);

    expect(res.body.error).toContain("nope");
  });
});
