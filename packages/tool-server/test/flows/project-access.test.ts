import { describe, it, expect, vi } from "vitest";
import type { ToolContext } from "@argent/registry";
import { ClientProjectAccess } from "../../src/tools/flows/project-access";

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
