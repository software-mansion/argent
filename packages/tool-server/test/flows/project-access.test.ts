import { describe, it, expect, vi } from "vitest";
import {
  CLIENT_CONTENT_CAP_BYTES,
  CLIENT_FILE_OP_TIMEOUT_MS,
  getFailureSignal,
  type ClientServiceOp,
  type ToolContext,
} from "@argent/registry";
import { ClientProjectAccess, clientBaselinePath } from "../../src/tools/flows/project-access";

type ClientServices = NonNullable<ToolContext["clientServices"]>;

function servicesAnswering(
  request: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
): ClientServices & { request: ReturnType<typeof vi.fn> } {
  return {
    ops: ["resolve-file"],
    roots: ["/client"],
    request: vi.fn((_op: string, args: Record<string, unknown>) => request(args)),
  };
}

const served = (args: Record<string, unknown>) =>
  Promise.resolve({
    canonical: `${String(args.anchorDir)}/${String(args.target)}`,
    spelling: { state: "listed" },
    exists: true,
    content: Buffer.from(`steps: [] # ${String(args.target)}`).toString("base64"),
  });

describe("ClientProjectAccess", () => {
  it("asks the client once per anchorDir and target for the whole call", async () => {
    const services = servicesAnswering(served);
    const project = new ClientProjectAccess(services);

    const [first, concurrent] = await Promise.all([
      project.resolveFlowFile("/client/flows", "a.yaml"),
      project.resolveFlowFile("/client/flows", "a.yaml"),
    ]);
    const later = await project.resolveFlowFile("/client/flows", "a.yaml");
    // The same file spelled against another directory is another reference.
    const other = await project.resolveFlowFile("/client", "flows/a.yaml");

    expect(concurrent).toBe(first);
    expect(later).toBe(first);
    expect(await later.read()).toBe("steps: [] # a.yaml");
    expect(other.canonical).toBe("/client/flows/a.yaml");
    expect(services.request.mock.calls.map(([, args]) => args)).toEqual([
      { anchorDir: "/client/flows", target: "a.yaml", kind: "flow" },
      { anchorDir: "/client", target: "flows/a.yaml", kind: "flow" },
    ]);
  });

  it("gives every later reader the same rejection without asking again", async () => {
    const refusal = new Error("outside every root");
    const services = servicesAnswering(() => Promise.reject(refusal));
    const project = new ClientProjectAccess(services);

    await expect(project.resolveFlowFile("/client/flows", "a.yaml")).rejects.toBe(refusal);
    await expect(project.resolveFlowFile("/client/flows", "a.yaml")).rejects.toBe(refusal);
    expect(services.request).toHaveBeenCalledTimes(1);
  });
});

/** A channel whose every request answers with `answer`, recording what was asked. */
function channel(answer: Record<string, unknown>) {
  const request = vi.fn(
    async (_op: ClientServiceOp, _args: Record<string, unknown>, _timeoutMs: number) => answer
  );
  const services: ClientServices = {
    ops: ["resolve-file", "read-file", "write-file"],
    roots: ["/client"],
    request,
  };
  return { project: new ClientProjectAccess(services), request };
}

const BASELINE = "/client/proj/.argent/flows/__baselines__/login/home__ios-390x844.png";

describe("ClientProjectAccess baselines", () => {
  it("reads a baseline through read-file", async () => {
    const { project, request } = channel({ exists: true, size: 3, content: "AQID" });

    await expect(project.readFile(BASELINE)).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(request.mock.calls).toEqual([
      ["read-file", { path: BASELINE }, CLIENT_FILE_OP_TIMEOUT_MS],
    ]);
  });

  it("answers null for a baseline the client does not have", async () => {
    const { project } = channel({ exists: false });

    await expect(project.readFile(BASELINE)).resolves.toBeNull();
  });

  it.each([[{}], [{ exists: "yes" }], [{ exists: true }]])(
    "rejects the malformed read-file answer %j",
    async (answer) => {
      const err = await channel(answer)
        .project.readFile(BASELINE)
        .catch((e: unknown) => e);

      expect(getFailureSignal(err)?.failure_stage).toBe("client_request_refused");
      expect((err as Error).message).toContain(`read-file request for "${BASELINE}"`);
    }
  );

  it("writes a baseline through write-file and passes on whether it replaced one", async () => {
    const { project, request } = channel({ written: BASELINE, replaced: true });

    await expect(project.writeBaseline(BASELINE, Buffer.from([1, 2, 3]))).resolves.toEqual({
      replaced: true,
    });
    expect(request.mock.calls).toEqual([
      ["write-file", { path: BASELINE, content: "AQID" }, CLIENT_FILE_OP_TIMEOUT_MS],
    ]);
  });

  it("refuses a baseline above the cap without sending it", async () => {
    const { project, request } = channel({ written: BASELINE, replaced: false });

    const err = await project
      .writeBaseline(BASELINE, Buffer.alloc(CLIENT_CONTENT_CAP_BYTES + 1))
      .catch((e: unknown) => e);

    // On a slow connection, sending it would report the timeout, not the cap.
    expect(request).not.toHaveBeenCalled();
    expect((err as Error).message).toBe(
      `the baseline for "${BASELINE}" is larger than the 32 MiB cap on a file the client ` +
        `writes, so this tool-server did not send it`
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("client_content_cap");
  });

  it("sends a baseline at the cap", async () => {
    const { project, request } = channel({ written: BASELINE, replaced: false });

    await expect(
      project.writeBaseline(BASELINE, Buffer.alloc(CLIENT_CONTENT_CAP_BYTES))
    ).resolves.toEqual({ replaced: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([[{}], [{ written: BASELINE }], [{ replaced: false }]])(
    "rejects the malformed write-file answer %j",
    async (answer) => {
      const err = await channel(answer)
        .project.writeBaseline(BASELINE, Buffer.from([1]))
        .catch((e: unknown) => e);

      expect(getFailureSignal(err)?.failure_stage).toBe("client_request_refused");
      expect((err as Error).message).toContain(`write-file request for "${BASELINE}"`);
    }
  );

  it("puts a client baseline beside the root flow's file", () => {
    expect(clientBaselinePath("/client/vault/b.yaml", "b", "home.png")).toBe(
      "/client/vault/__baselines__/b/home.png"
    );
  });
});
