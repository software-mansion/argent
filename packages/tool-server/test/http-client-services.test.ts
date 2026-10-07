import { describe, it, expect, vi, afterEach } from "vitest";
import supertest from "supertest";
import type { Response } from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { createHttpApp, type HttpAppHandle } from "../src/http";
import {
  ArtifactStore,
  CLIENT_CONTENT_CAP_BYTES,
  FAILURE_CODES,
  getFailureSignal,
  Registry,
  type InvokeToolOptions,
  type ToolContext,
  type ToolDefinition,
  zodObjectToJsonSchema,
} from "@argent/registry";
import { isClientRequestAbort } from "../src/client-requests";
import { createRunFlowTool, type FlowRunResult } from "../src/tools/flows/flow-run";
import { serializeFlow } from "../src/tools/flows/flow-utils";

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

// The dependency preflight of `gated-tool` waits on this hook, so a test can
// hold a call inside the awaits that come before the tool runs.
let depsHook: () => Promise<void> = async () => {};
vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDeps: vi.fn(() => depsHook()),
}));

// File-input resolution waits on this hook first, so a test can hold a call
// inside it; `filesCleanup` records each call's cleanup.
let filesHook: () => Promise<void> = async () => {};
const filesCleanup = vi.fn();
vi.mock("../src/file-inputs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/file-inputs")>();
  return {
    ...actual,
    resolveFileInputs: vi.fn(async (...args: Parameters<typeof actual.resolveFileInputs>) => {
      await filesHook();
      const resolved = await actual.resolveFileInputs(...args);
      return {
        ...resolved,
        cleanup: async () => {
          filesCleanup();
          await resolved.cleanup();
        },
      };
    }),
  };
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADVERT = { ops: ["resolve-file"] as const };
const CLIENT_SERVICES = { ops: ["resolve-file"], roots: ["/proj"] };
const RESOLVE_ARGS = { anchorDir: "/proj/flows", target: "login.yaml", kind: "flow" };

type ToolImpl = (params: unknown, options: InvokeToolOptions | undefined) => Promise<unknown>;

/**
 * `served-tool` advertises client services, `plain-tool` does not;
 * `strict-tool` advertises them behind a schema that refuses unknown keys, and
 * `gated-tool` behind a dependency preflight.
 */
function stubRegistry(impl: ToolImpl = async () => ({ ok: true })): Registry {
  return {
    getSnapshot: vi.fn(() => ({
      services: new Map(),
      namespaces: [],
      tools: ["served-tool", "plain-tool", "strict-tool", "gated-tool"],
    })),
    getTool: vi.fn((name: string) => {
      if (name === "served-tool") {
        return {
          id: "served-tool",
          description: "A stub tool that can use client services",
          inputSchema: { type: "object", properties: {} },
          clientServices: { ops: [...ADVERT.ops] },
          services: () => ({}),
          execute: async () => ({ ok: true }),
        };
      }
      if (name === "strict-tool") {
        const zodSchema = z.object({ name: z.string() }).strict();
        return {
          id: "strict-tool",
          description: "A stub tool with client services and a strict schema",
          zodSchema,
          inputSchema: zodObjectToJsonSchema(zodSchema),
          clientServices: { ops: [...ADVERT.ops] },
          services: () => ({}),
          execute: async () => ({ ok: true }),
        };
      }
      if (name === "gated-tool") {
        return {
          id: "gated-tool",
          description: "A stub tool with client services and a dependency preflight",
          inputSchema: { type: "object", properties: {} },
          clientServices: { ops: [...ADVERT.ops] },
          requires: ["gate"],
          services: () => ({}),
          execute: async () => ({ ok: true }),
        };
      }
      if (name === "plain-tool") {
        return {
          id: "plain-tool",
          description: "A stub tool without client services",
          inputSchema: { type: "object", properties: {} },
          services: () => ({}),
          execute: async () => ({ ok: true }),
        };
      }
      return undefined;
    }),
    invokeTool: vi.fn((_name: string, params: unknown, options?: InvokeToolOptions) =>
      impl(params, options)
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

/**
 * supertest buffers the whole body, so a stream that waits for an answer can
 * only be driven through a real socket: a listening server plus global fetch.
 */
async function listen(handle: HttpAppHandle): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handle.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function* ndjsonLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim().length > 0) yield JSON.parse(line) as Record<string, unknown>;
      newline = buffered.indexOf("\n");
    }
  }
}

function startCall(
  base: string,
  tool: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<globalThis.Response> {
  return fetch(`${base}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/x-ndjson" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function postAnswer(
  base: string,
  invocation: string,
  body: Record<string, unknown>
): Promise<globalThis.Response> {
  return fetch(`${base}/invocations/${invocation}/client-responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("HTTP client services", () => {
  let handle: HttpAppHandle | undefined;
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    handle?.dispose();
    handle = undefined;
    vi.clearAllMocks();
  });

  it("advertises clientServices in GET /tools when the definition carries it", async () => {
    handle = createHttpApp(stubRegistry());

    const res = await supertest(handle.app).get("/tools").expect(200);

    const byName = new Map<string, Record<string, unknown>>(
      (res.body.tools as Record<string, unknown>[]).map((t) => [t.name as string, t])
    );
    expect(byName.get("served-tool")!.clientServices).toEqual({
      ops: ["resolve-file"],
    });
    expect(byName.get("plain-tool")).not.toHaveProperty("clientServices");
  });

  it("passes clientServices into invokeTool for an NDJSON request that carries client_services", async () => {
    let seen: InvokeToolOptions | undefined;
    handle = createHttpApp(
      stubRegistry(async (_params, options) => {
        seen = options;
        return { ok: true };
      })
    );

    const res = await supertest(handle.app)
      .post("/tools/served-tool")
      .set("Accept", "application/x-ndjson")
      .send({ client_services: CLIENT_SERVICES })
      .buffer(true)
      .parse(collectText)
      .expect(200);

    expect(parseLines(res.body as string)).toEqual([{ event: "result", data: { ok: true } }]);
    expect(seen?.clientServices).toMatchObject({
      ops: ["resolve-file"],
      roots: ["/proj"],
    });
    expect(seen?.clientServices?.request).toBeTypeOf("function");
    expect(seen?.emitProgress).toBeTypeOf("function");
  });

  it("passes no clientServices when the request carries no client_services", async () => {
    let seen: InvokeToolOptions | undefined;
    handle = createHttpApp(
      stubRegistry(async (_params, options) => {
        seen = options;
        return { ok: true };
      })
    );

    await supertest(handle.app)
      .post("/tools/served-tool")
      .set("Accept", "application/x-ndjson")
      .send({ project_root: "/proj" })
      .buffer(true)
      .parse(collectText)
      .expect(200);

    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("clientServices");
    // The same for a plain JSON call.
    seen = undefined;
    await supertest(handle.app).post("/tools/served-tool").send({}).expect(200);
    expect(seen).toBeDefined();
    expect(seen).not.toHaveProperty("clientServices");
  });

  // The parameter comes off the arguments before the tool's schema and the
  // tool see them: neither declares it.
  it("hands a tool without a schema its arguments without client_services", async () => {
    let seen: unknown;
    handle = createHttpApp(
      stubRegistry(async (params) => {
        seen = params;
        return { ok: true };
      })
    );

    await supertest(handle.app)
      .post("/tools/served-tool")
      .set("Accept", "application/x-ndjson")
      .send({ name: "main", client_services: CLIENT_SERVICES })
      .buffer(true)
      .parse(collectText)
      .expect(200);

    expect(seen).toEqual({ name: "main" });
  });

  it("runs a tool whose strict schema does not declare client_services", async () => {
    let seen: unknown;
    handle = createHttpApp(
      stubRegistry(async (params) => {
        seen = params;
        return { ok: true };
      })
    );

    const res = await supertest(handle.app)
      .post("/tools/strict-tool")
      .set("Accept", "application/x-ndjson")
      .send({ name: "main", client_services: CLIENT_SERVICES })
      .buffer(true)
      .parse(collectText)
      .expect(200);

    expect(parseLines(res.body as string)).toEqual([{ event: "result", data: { ok: true } }]);
    expect(seen).toEqual({ name: "main" });
  });

  // Marked validation: the CLI's directory run fails only the flow it rejects
  // and goes on, as for any rejection of one call.
  it("answers 400 marked validation when client_services arrives without Accept: application/x-ndjson", async () => {
    const recordFailure = vi.fn();
    const registry = stubRegistry();
    handle = createHttpApp(registry, { recordFailure });

    const res = await supertest(handle.app)
      .post("/tools/served-tool")
      .send({ client_services: CLIENT_SERVICES })
      .expect(400);

    expect(res.body).toEqual({
      error:
        "client_services requires an NDJSON request (Accept: application/x-ndjson): its " +
        "requests travel on the response stream. A proxy that rewrites Accept removes it.",
      error_code: FAILURE_CODES.HTTP_ZOD_VALIDATION_FAILED,
      error_kind: "validation",
    });
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith(
      "served-tool",
      expect.any(Object),
      expect.objectContaining({
        error_code: FAILURE_CODES.HTTP_ZOD_VALIDATION_FAILED,
        failure_stage: "http_client_services_stream",
        error_kind: "validation",
      }),
      expect.any(Number)
    );
  });

  it("answers 400 with HTTP_ZOD_VALIDATION_FAILED, marked validation, for a malformed client_services", async () => {
    const recordFailure = vi.fn();
    const registry = stubRegistry();
    handle = createHttpApp(registry, { recordFailure });

    const res = await supertest(handle.app)
      .post("/tools/served-tool")
      .set("Accept", "application/x-ndjson")
      .send({ client_services: { ops: ["resolve-file"], roots: ["relative/dir"] } })
      .expect(400);

    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({
      error: "client_services: each root must be an absolute path",
      error_code: FAILURE_CODES.HTTP_ZOD_VALIDATION_FAILED,
      error_kind: "validation",
    });
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledWith(
      "served-tool",
      expect.any(Object),
      expect.objectContaining({
        error_code: FAILURE_CODES.HTTP_ZOD_VALIDATION_FAILED,
        failure_stage: "http_zod_validation",
        error_kind: "validation",
      }),
      expect.any(Number)
    );
  });

  it("keeps the answer route behind the bearer-token middleware", async () => {
    const originalToken = process.env.ARGENT_AUTH_TOKEN;
    process.env.ARGENT_AUTH_TOKEN = "test-secret-token";
    try {
      handle = createHttpApp(stubRegistry());
      const body = { id: "some-id", ok: true };

      await supertest(handle.app)
        .post("/invocations/inv-1/client-responses")
        .send(body)
        .expect(401);
      await supertest(handle.app)
        .post("/invocations/inv-1/client-responses")
        .set("Authorization", "Bearer wrong-token")
        .send(body)
        .expect(401);
      // With the token the request reaches the broker, which knows no such call.
      const res = await supertest(handle.app)
        .post("/invocations/inv-1/client-responses")
        .set("Authorization", "Bearer test-secret-token")
        .send(body)
        .expect(404);
      expect(res.body).toEqual({ error: "unknown invocation" });
    } finally {
      if (originalToken === undefined) delete process.env.ARGENT_AUTH_TOKEN;
      else process.env.ARGENT_AUTH_TOKEN = originalToken;
    }
  });

  it("streams a client-request line, accepts the POSTed answer with 200, and resolves the tool with it", async () => {
    let invocationSeen: string | undefined;
    handle = createHttpApp(
      stubRegistry(async (_params, options) => {
        invocationSeen = options?.toolInvocationId;
        options?.emitProgress?.({ index: 0, status: "pass" });
        const answer = await options!.clientServices!.request("resolve-file", RESOLVE_ARGS, 30_000);
        options?.emitProgress?.({ index: 1, status: "pass" });
        return { fragment: answer };
      })
    );
    let base: string;
    ({ server, base } = await listen(handle));

    const res = await startCall(base, "served-tool", { client_services: CLIENT_SERVICES });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const lines: Record<string, unknown>[] = [];
    for await (const line of ndjsonLines(res.body!)) {
      lines.push(line);
      if (line.event === "client-request") {
        const answer = await postAnswer(base, line.invocation as string, {
          id: line.id,
          ok: true,
          canonical: "/proj/flows/login.yaml",
          spelling: { state: "listed" },
          exists: true,
          size: 1,
          mtimeMs: 2,
          content: "YQ==",
        });
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ accepted: true });
      }
    }

    const expectedFragment = {
      canonical: "/proj/flows/login.yaml",
      spelling: { state: "listed" },
      exists: true,
      size: 1,
      mtimeMs: 2,
      content: "YQ==",
    };
    expect(lines).toEqual([
      { event: "progress", data: { index: 0, status: "pass" } },
      {
        event: "client-request",
        invocation: invocationSeen,
        id: expect.stringMatching(UUID),
        op: "resolve-file",
        args: RESOLVE_ARGS,
      },
      { event: "progress", data: { index: 1, status: "pass" } },
      { event: "result", data: { fragment: expectedFragment } },
    ]);
    expect(invocationSeen).toMatch(UUID);
  });

  it("answers 404 for an unknown invocation and 409 for a second answer", async () => {
    // Two requests in a row: the second keeps the invocation open while the
    // duplicate answer to the first arrives (a finished call forgets its ids).
    handle = createHttpApp(
      stubRegistry(async (_params, options) => {
        const request = options!.clientServices!.request;
        const first = await request("resolve-file", { target: "/proj" }, 30_000);
        const second = await request("resolve-file", { target: "/proj/flows" }, 30_000);
        return { first, second };
      })
    );
    let base: string;
    ({ server, base } = await listen(handle));

    const res = await startCall(base, "served-tool", { client_services: CLIENT_SERVICES });
    const reader = ndjsonLines(res.body!);
    const first = (await reader.next()).value!;
    expect(first.event).toBe("client-request");
    const invocation = first.invocation as string;
    const id = first.id as string;

    // Malformed bodies never reach the broker.
    const noId = await postAnswer(base, invocation, { ok: true });
    expect(noId.status).toBe(400);
    expect(await noId.json()).toEqual({ error: "the body must carry a non-empty string id" });
    const noOk = await postAnswer(base, invocation, { id });
    expect(noOk.status).toBe(400);
    expect(await noOk.json()).toEqual({ error: "the body must carry a boolean ok" });
    const noError = await postAnswer(base, invocation, { id, ok: false });
    expect(noError.status).toBe(400);
    expect(await noError.json()).toEqual({
      error: "a refusal (ok: false) must carry a string error",
    });

    const unknownInvocation = await postAnswer(base, "not-an-invocation", { id, ok: true });
    expect(unknownInvocation.status).toBe(404);
    expect(await unknownInvocation.json()).toEqual({ error: "unknown invocation" });

    const unknownRequest = await postAnswer(base, invocation, { id: "not-a-request", ok: true });
    expect(unknownRequest.status).toBe(404);
    expect(await unknownRequest.json()).toEqual({ error: "unknown or expired request id" });

    const accepted = await postAnswer(base, invocation, { id, ok: true, entries: ["a.yaml"] });
    expect(accepted.status).toBe(200);

    const duplicate = await postAnswer(base, invocation, { id, ok: true, entries: ["b.yaml"] });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "the request already has an answer" });

    const next = (await reader.next()).value!;
    expect(next).toMatchObject({
      event: "client-request",
      invocation,
      args: { target: "/proj/flows" },
    });
    expect(next.id).not.toBe(id);
    const second = await postAnswer(base, invocation, { id: next.id, ok: true, entries: [] });
    expect(second.status).toBe(200);

    const rest: Record<string, unknown>[] = [];
    for await (const line of reader) rest.push(line);
    expect(rest).toEqual([
      { event: "result", data: { first: { entries: ["a.yaml"] }, second: { entries: [] } } },
    ]);

    // Once the call ended, its invocation is gone.
    const afterEnd = await postAnswer(base, invocation, { id, ok: true });
    expect(afterEnd.status).toBe(404);
    expect(await afterEnd.json()).toEqual({ error: "unknown invocation" });
  });

  it("answers 413 when content is above 32 MiB", async () => {
    handle = createHttpApp(
      stubRegistry(async (_params, options) => {
        try {
          await options!.clientServices!.request("resolve-file", RESOLVE_ARGS, 30_000);
          return { outcome: "resolved" };
        } catch (err) {
          return {
            outcome: "rejected",
            stage: getFailureSignal(err)?.failure_stage,
            message: (err as Error).message,
          };
        }
      })
    );
    let base: string;
    ({ server, base } = await listen(handle));

    const res = await startCall(base, "served-tool", { client_services: CLIENT_SERVICES });
    const reader = ndjsonLines(res.body!);
    const first = (await reader.next()).value!;
    expect(first.event).toBe("client-request");

    // One base64 character past what 32 MiB encodes to.
    const content = "a".repeat(Math.ceil(CLIENT_CONTENT_CAP_BYTES / 3) * 4 + 1);
    const tooBig = await postAnswer(base, first.invocation as string, {
      id: first.id,
      ok: true,
      content,
    });
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({
      error: "the answer's content decodes to more than 32 MiB",
    });

    // The pending step failed at once with a refusal rather than waiting out
    // the 30 s timeout.
    const rest: Record<string, unknown>[] = [];
    for await (const line of reader) rest.push(line);
    expect(rest).toEqual([
      {
        event: "result",
        data: {
          outcome: "rejected",
          stage: "client_request_refused",
          message:
            'the client refused the resolve-file request for "login.yaml": ' +
            "the answer's content exceeds the 32 MiB cap",
        },
      },
    ]);
  }, 20_000);

  it("does not run a call whose client hung up before the call started", async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    depsHook = async () => {
      reached.resolve();
      await release.promise;
    };
    const impl = vi.fn(async () => ({ ok: true }));
    handle = createHttpApp(stubRegistry(impl));
    let base: string;
    ({ server, base } = await listen(handle));

    try {
      const controller = new AbortController();
      const call = startCall(
        base,
        "gated-tool",
        { client_services: CLIENT_SERVICES },
        controller.signal
      ).catch((err: unknown) => err);
      await reached.promise;
      controller.abort();
      await call;
      // Wait until the server has seen the connection close, then let the
      // preflight finish: the tool must not run for nobody.
      for (let i = 0; i < 100; i++) {
        const open = await new Promise<number>((r) => server!.getConnections((_e, n) => r(n)));
        if (open === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      release.resolve();
      await new Promise((r) => setTimeout(r, 50));

      expect(impl).not.toHaveBeenCalled();
    } finally {
      depsHook = async () => {};
    }
  });

  it("removes the uploads of a call whose client hung up while they were resolved", async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    filesHook = async () => {
      reached.resolve();
      await release.promise;
    };
    filesCleanup.mockClear();
    const impl = vi.fn(async () => ({ ok: true }));
    handle = createHttpApp(stubRegistry(impl));
    let base: string;
    ({ server, base } = await listen(handle));

    try {
      const controller = new AbortController();
      const call = startCall(
        base,
        "served-tool",
        { client_services: CLIENT_SERVICES },
        controller.signal
      ).catch((err: unknown) => err);
      await reached.promise;
      controller.abort();
      await call;
      for (let i = 0; i < 100; i++) {
        const open = await new Promise<number>((r) => server!.getConnections((_e, n) => r(n)));
        if (open === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      release.resolve();
      await vi.waitFor(() => expect(filesCleanup).toHaveBeenCalledTimes(1));

      expect(impl).not.toHaveBeenCalled();
    } finally {
      filesHook = async () => {};
    }
  });

  it("rejects pending requests when the client disconnects", async () => {
    const rejection = deferred<unknown>();
    const finished = deferred<void>();
    handle = createHttpApp(
      stubRegistry(async (_params, options) => {
        try {
          await options!.clientServices!.request("resolve-file", RESOLVE_ARGS, 30_000);
          rejection.resolve(null);
        } catch (err) {
          rejection.resolve(err);
        }
        finished.resolve();
        return { ok: true };
      })
    );
    let base: string;
    ({ server, base } = await listen(handle));

    const controller = new AbortController();
    const res = await startCall(
      base,
      "served-tool",
      { client_services: CLIENT_SERVICES },
      controller.signal
    );
    const reader = ndjsonLines(res.body!);
    const first = (await reader.next()).value!;
    expect(first.event).toBe("client-request");

    controller.abort();
    await expect(reader.next()).rejects.toMatchObject({ name: "AbortError" });

    const err = await rejection.promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).message).toBe(
      "the client disconnected before answering the resolve-file request"
    );
    expect(isClientRequestAbort(err)).toBe(true);
    // The tool returns normally after the abort; the route tolerates the
    // closed socket.
    await finished.promise;
  });
});

/**
 * The REAL flow-execute behind the HTTP layer, its steps dispatched to a stub,
 * so a call exercises the whole client-services chain: the advert in the
 * listing, the parameter taken off the body, the stream, the answer route and
 * the runner's client-mode resolution.
 */
function flowRegistry(): Registry {
  const flowExecute = createRunFlowTool({
    invokeTool: vi.fn(async () => ({ ok: true })),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry);
  // What registration derives for the listing.
  flowExecute.inputSchema = zodObjectToJsonSchema(flowExecute.zodSchema!);
  return {
    getSnapshot: vi.fn(() => ({ services: new Map(), namespaces: [], tools: ["flow-execute"] })),
    getTool: vi.fn((id: string) => (id === "flow-execute" ? flowExecute : undefined)),
    invokeTool: vi.fn(async (_id: string, args: unknown, opts?: Partial<ToolContext>) =>
      flowExecute.execute({}, args as never, { artifacts: new ArtifactStore(), ...opts })
    ),
  } as unknown as Registry;
}

describe("flow-execute over client services", () => {
  let handle: HttpAppHandle | undefined;
  let server: http.Server | undefined;

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("advertises resolve-file and keeps client_services out of its input schema", async () => {
    handle = createHttpApp(flowRegistry());

    const res = await supertest(handle.app).get("/tools").expect(200);

    const entry = (res.body.tools as Record<string, unknown>[]).find(
      (t) => t.name === "flow-execute"
    )!;
    expect(entry.clientServices).toEqual({ ops: ["resolve-file"] });
    const properties = (entry.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toContain("flow_path");
    expect(Object.keys(properties)).not.toContain("client_services");
  });

  it("runs an uploaded flow's run: fragment that the client serves", async () => {
    handle = createHttpApp(flowRegistry());
    let base: string;
    ({ server, base } = await listen(handle));
    const clientFiles: Record<string, string> = {
      "/client/flows/root.yaml": serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "run", flow: "frag.yaml" }],
      }),
      "/client/flows/frag.yaml": serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "served by the client" }],
      }),
    };
    const root = clientFiles["/client/flows/root.yaml"]!;

    const res = await startCall(base, "flow-execute", {
      project_root: "/client",
      device: "00000000-0000-0000-0000-0000000000ab",
      flow_path: {
        __argentFileInput: true,
        path: "/client/flows/root.yaml",
        size: Buffer.byteLength(root),
        mtimeMs: 1,
        content: Buffer.from(root).toString("base64"),
      },
      client_services: { ops: ["resolve-file"], roots: ["/client"] },
    });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const asked: string[] = [];
    let result: Record<string, unknown> | undefined;
    for await (const line of ndjsonLines(res.body!)) {
      if (line.event === "client-request") {
        const args = line.args as { anchorDir: string; target: string };
        const canonical = `${args.anchorDir}/${args.target}`;
        asked.push(canonical);
        const text = clientFiles[canonical];
        await fetch(`${base}/invocations/${line.invocation as string}/client-responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            text === undefined
              ? { id: line.id, ok: true, canonical, spelling: { state: "absent" }, exists: false }
              : {
                  id: line.id,
                  ok: true,
                  canonical,
                  spelling: { state: "listed" },
                  exists: true,
                  content: Buffer.from(text).toString("base64"),
                }
          ),
        });
      } else if (line.event === "result") {
        result = line.data as Record<string, unknown>;
      }
    }

    expect(asked).toEqual(["/client/flows/root.yaml", "/client/flows/frag.yaml"]);
    expect(result).toMatchObject({ ok: true });
    const reported = (result!.steps as { kind: string; message?: string }[]).map(
      (step) => `${step.kind}:${step.message ?? ""}`
    );
    expect(reported).toEqual(["run:", "echo:served by the client"]);
  });

  it("reports every step as an aborted skip when the client hangs up at the root flow's request", async () => {
    // The first request of a composing run comes before step 1. A client that
    // hangs up there (Ctrl-C right after the start) cancelled the run, as one
    // that hangs up at any later request did: the call completes with every
    // step skipped, rather than failing with a stack in the log.
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry));
    registry.registerTool({
      id: "list-devices",
      description: "One Chromium instance to attach to",
      inputSchema: { type: "object", properties: {} },
      services: () => ({}),
      execute: async () => ({ devices: [{ platform: "chromium", id: "chromium-cdp-9999" }] }),
    } as unknown as ToolDefinition);
    const outcome = deferred<string>();
    registry.events.on("toolCompleted", (id: string) => {
      if (id === "flow-execute") outcome.resolve("toolCompleted");
    });
    registry.events.on("toolFailed", (id: string) => {
      if (id === "flow-execute") outcome.resolve("toolFailed");
    });
    const invoke = vi.spyOn(registry, "invokeTool");
    const resolveService = vi.spyOn(registry, "resolveService");
    handle = createHttpApp(registry);
    let base: string;
    ({ server, base } = await listen(handle));
    const root = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "root" },
        { kind: "run", flow: "frag.yaml" },
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.5 } },
      ],
    });

    const controller = new AbortController();
    const res = await startCall(
      base,
      "flow-execute",
      {
        project_root: "/client",
        flow_path: {
          __argentFileInput: true,
          path: "/client/flows/root.yaml",
          size: Buffer.byteLength(root),
          mtimeMs: 1,
          content: Buffer.from(root).toString("base64"),
        },
        client_services: { ops: ["resolve-file"], roots: ["/client"] },
      },
      controller.signal
    );
    const reader = ndjsonLines(res.body!);
    const first = (await reader.next()).value!;
    expect(first).toMatchObject({ event: "client-request", args: { target: "root.yaml" } });
    controller.abort();
    await expect(reader.next()).rejects.toMatchObject({ name: "AbortError" });

    expect(await outcome.promise).toBe("toolCompleted");
    const call = invoke.mock.calls.findIndex(([id]) => id === "flow-execute");
    const result = (await invoke.mock.results[call]!.value) as FlowRunResult;
    expect(result.aborted).toBe(true);
    expect(result.steps.map((s) => `${s.kind}:${s.status}:${s.reason ?? ""}`)).toEqual([
      "echo:skip:run aborted",
      "run:skip:run aborted",
      "tool:skip:run aborted",
    ]);
    // No step ran and no device was acted on: the listing is the only other
    // tool call, and the Chromium page was not brought to the front.
    expect(invoke.mock.calls.map(([id]) => id)).toEqual(["flow-execute", "list-devices"]);
    expect(resolveService).not.toHaveBeenCalled();
  });
});
