import { describe, it, expect } from "vitest";
import { flowMemberKey, getFailureSignal, type ResolvedMember } from "@argent/registry";
import { ClientProjectAccess } from "../../src/tools/flows/project-access";

const members: Record<string, ResolvedMember> = {
  [flowMemberKey("/client/flows", "a.yaml")]: {
    role: "flow",
    state: "present",
    canonical: "/client/flows/a.yaml",
    spelling: { state: "listed" },
    text: "steps: [] # a.yaml",
  },
  [flowMemberKey("/client/flows", "Gone.yaml")]: {
    role: "flow",
    state: "missing",
    canonical: "/client/flows/Gone.yaml",
    spelling: { state: "case_folded", actual: "gone.yaml", addressable: true },
  },
  [flowMemberKey("/client/flows", "../../etc/x.yaml")]: {
    role: "flow",
    state: "refused",
    canonical: "/etc/x.yaml",
    spelling: { state: "listed" },
    error: "../../etc/x.yaml is outside every root this client serves (/client)",
  },
};

describe("ClientProjectAccess", () => {
  const project = new ClientProjectAccess(members);

  it("resolves a member the client sent to its real path, spelling and text", async () => {
    const hop = await project.resolveFlowFile("/client/flows", "a.yaml");

    expect(hop.canonical).toBe("/client/flows/a.yaml");
    expect(hop.spelling).toEqual({ state: "listed" });
    expect(await hop.read()).toBe("steps: [] # a.yaml");
  });

  it("resolves a missing member with the client's real path and spelling, and no text", async () => {
    const hop = await project.resolveFlowFile("/client/flows", "Gone.yaml");

    expect(hop.canonical).toBe("/client/flows/Gone.yaml");
    expect(hop.spelling).toEqual({ state: "case_folded", actual: "gone.yaml", addressable: true });
    expect(await hop.read()).toBeNull();
  });

  it("rejects a member the client refused to send, with the client's reason", async () => {
    const err = await project.resolveFlowFile("/client/flows", "../../etc/x.yaml").then(
      () => new Error("resolved instead of being refused"),
      (e: unknown) => e as Error
    );

    expect(err.message).toBe(
      'the client refused to send "../../etc/x.yaml": ../../etc/x.yaml is outside every root ' +
        "this client serves (/client)"
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("client_member_refused");
  });

  it("rejects a pair the client did not send", async () => {
    // The same file spelled against another directory is another pair.
    await expect(project.resolveFlowFile("/client", "flows/a.yaml")).rejects.toThrow(
      'the client refused to send "flows/a.yaml": flows/a.yaml is not a run: target of a flow ' +
        "this client sent"
    );
  });

  it("finds a member by its pair, and nothing for a pair it does not hold", () => {
    expect(project.member("/client/flows", "a.yaml")?.state).toBe("present");
    expect(project.member("/client", "flows/a.yaml")).toBeUndefined();
    // An inherited property name is not a member.
    expect(new ClientProjectAccess({}).member("", "constructor")).toBeUndefined();
  });
});
