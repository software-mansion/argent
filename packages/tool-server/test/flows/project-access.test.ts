import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { flowMemberKey, getFailureSignal, type ResolvedMember } from "@argent/registry";
import { ClientProjectAccess, clientBaselinePath } from "../../src/tools/flows/project-access";

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

const BASELINE = "/client/proj/.argent/flows/__baselines__/login/home__ios-390x844.png";
const CAP = 32 * 1024 * 1024;

describe("ClientProjectAccess baselines", () => {
  let dir = "";
  let hostCopy = "";
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "project-access-baselines-"));
    hostCopy = path.join(dir, "home.png");
    await fs.writeFile(hostCopy, Buffer.from([1, 2, 3]));
  });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  const access = (baseline?: Partial<ResolvedMember>) =>
    new ClientProjectAccess(
      baseline === undefined
        ? {}
        : { [BASELINE]: { role: "baseline", state: "present", ...baseline } as ResolvedMember }
    );

  it("reads a baseline the client sent from its copy on this host", async () => {
    await expect(access({ hostPath: hostCopy }).readFile(BASELINE)).resolves.toEqual(
      Buffer.from([1, 2, 3])
    );
  });

  it("answers null for a baseline the client did not send, or sent as missing", async () => {
    await expect(access().readFile(BASELINE)).resolves.toBeNull();
    await expect(access({ state: "missing" }).readFile(BASELINE)).resolves.toBeNull();
  });

  it("refuses a baseline the client refused, with the client's reason", async () => {
    const err = await access({
      state: "refused",
      error: "it links to a file that is not a PNG file",
    })
      .readFile(BASELINE)
      .catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      `the client refused to send "${BASELINE}": it links to a file that is not a PNG file`
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("client_member_refused");
  });

  it("does not take a flow member for a baseline", async () => {
    const project = new ClientProjectAccess({
      [BASELINE]: { role: "flow", state: "present", text: "x" } as ResolvedMember,
    });
    await expect(project.readFile(BASELINE)).resolves.toBeNull();
  });

  it("keeps a write for the result and reads it back in the same call", async () => {
    const project = access({ hostPath: hostCopy });

    await expect(project.writeBaseline(BASELINE, Buffer.from([7, 8]))).resolves.toEqual({
      replaced: true,
    });
    await expect(project.readFile(BASELINE)).resolves.toEqual(Buffer.from([7, 8]));
    expect(project.baselineDirectives()).toEqual([
      { __argentClientFile: true, path: BASELINE, content: "Bwg=", encoding: "base64" },
    ]);
    // The client's own file stays as it was until the client writes the result.
    expect(await fs.readFile(hostCopy)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("says a write replaced a baseline the client listed by name", async () => {
    await expect(
      access({ state: "listed" }).writeBaseline(BASELINE, Buffer.from([1]))
    ).resolves.toEqual({ replaced: true });
    await expect(
      access({ state: "missing" }).writeBaseline(BASELINE, Buffer.from([1]))
    ).resolves.toEqual({ replaced: false });
  });

  it("says a second write of a new baseline replaced the first, and returns the last bytes", async () => {
    const project = access();

    await expect(project.writeBaseline(BASELINE, Buffer.from([1]))).resolves.toEqual({
      replaced: false,
    });
    await expect(project.writeBaseline(BASELINE, Buffer.from([2]))).resolves.toEqual({
      replaced: true,
    });
    expect(project.baselineDirectives().map((d) => d.content)).toEqual(["Ag=="]);
  });

  it("refuses to write a baseline the client refused, and keeps nothing", async () => {
    const project = access({ state: "refused", error: `${BASELINE} is not a regular file` });

    const err = await project.writeBaseline(BASELINE, Buffer.from([1])).catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      `the client refused to write "${BASELINE}": ${BASELINE} is not a regular file`
    );
    expect(project.baselineDirectives()).toEqual([]);
  });

  it("refuses a baseline above the cap, and keeps one at the cap", async () => {
    const project = access();

    const err = await project
      .writeBaseline(BASELINE, Buffer.alloc(CAP + 1))
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `the baseline for "${BASELINE}" is larger than the 32 MiB cap on a file the client ` +
        `writes, so this tool-server did not keep it`
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("client_content_cap");
    expect(project.baselineDirectives()).toEqual([]);

    await expect(project.writeBaseline(BASELINE, Buffer.alloc(CAP))).resolves.toEqual({
      replaced: false,
    });
  });

  it("reads the file argument of a tool: step the client sent, by the path as spelled", async () => {
    const spelled = "/client/img/../img/a.png";
    const project = new ClientProjectAccess({
      [spelled]: { role: "tool", state: "present", hostPath: hostCopy },
      "/client/img/gone.png": { role: "tool", state: "missing" },
      "/client/img/secret.png": {
        role: "tool",
        state: "refused",
        error: "/client/img/secret.png links to a file that is not one of .png, .yaml",
      },
    });

    await expect(project.readFile(spelled)).resolves.toEqual(Buffer.from([1, 2, 3]));
    // Another spelling of the same file is another key.
    await expect(project.readFile("/client/img/a.png")).resolves.toBeNull();
    await expect(project.readFile("/client/img/gone.png")).resolves.toBeNull();
    const err = await project.readFile("/client/img/secret.png").catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'the client refused to send "/client/img/secret.png": ' +
        "/client/img/secret.png links to a file that is not one of .png, .yaml"
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("client_member_refused");
  });

  it("takes a tool file at a baseline's path for that baseline, and reads a write there first", async () => {
    // The client sends one path once: a tool: step that names a baseline of
    // the run carries its bytes, also in a run that updates baselines.
    const project = new ClientProjectAccess({
      [BASELINE]: { role: "tool", state: "present", hostPath: hostCopy },
    });

    await expect(project.readFile(BASELINE)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(project.writeBaseline(BASELINE, Buffer.from([9]))).resolves.toEqual({
      replaced: true,
    });
    // A later tool: step of the same call reads the new baseline.
    await expect(project.readFile(BASELINE)).resolves.toEqual(Buffer.from([9]));
    const missing = new ClientProjectAccess({ [BASELINE]: { role: "tool", state: "missing" } });
    await expect(missing.writeBaseline(BASELINE, Buffer.from([9]))).resolves.toEqual({
      replaced: false,
    });
  });

  it("puts a client baseline beside the root flow's file", () => {
    expect(clientBaselinePath("/client/vault/b.yaml", "b", "home.png")).toBe(
      "/client/vault/__baselines__/b/home.png"
    );
  });
});
