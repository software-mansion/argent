import { describe, it, expect, vi } from "vitest";
import {
  CLIENT_FILE_OP_TIMEOUT_MS,
  getFailureSignal,
  type ClientServiceOp,
  type ToolContext,
} from "@argent/registry";
import { ClientProjectAccess, clientBaselinePath } from "../../src/tools/flows/project-access";

/** A channel whose every request answers with `answer`, recording what was asked. */
function channel(answer: Record<string, unknown>) {
  const request = vi.fn(
    async (_op: ClientServiceOp, _args: Record<string, unknown>, _timeoutMs: number) => answer
  );
  const services: NonNullable<ToolContext["clientServices"]> = {
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

  it("puts a client baseline beside the root flow's file, with POSIX separators", () => {
    expect(clientBaselinePath("/client/vault/b.yaml", "b", "home.png")).toBe(
      "/client/vault/__baselines__/b/home.png"
    );
  });
});
