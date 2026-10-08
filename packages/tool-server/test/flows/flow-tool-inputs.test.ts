import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  flowMemberKey,
  getFailureSignal,
  type OnDiskSpelling,
  type Registry,
  type ResolvedMember,
  type ToolDefinition,
  type ToolStepFile,
} from "@argent/registry";
import { FileInputError } from "../../src/file-inputs";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import {
  prepareToolStepInputs,
  refusedToolInputFix,
  servedToolInput,
  toolFilePathHints,
  toolStepFilePaths,
  toolStepUploadIssue,
  uploadUpdateHint,
} from "../../src/tools/flows/flow-tool-inputs";
import { ClientProjectAccess, type ProjectAccess } from "../../src/tools/flows/project-access";
import { reinstallAppTool } from "../../src/tools/reinstall-app";
import { screenshotDiffTool } from "../../src/tools/screenshot-diff";
import { gatherWorkspaceDataTool } from "../../src/tools/workspace/gather-workspace-data";
import { redirectTmpdir } from "../helpers/tmpdir-env";

// The real definitions, so a spec change in a tool shows up here as it would
// in a flow: screenshot-diff (two `file` inputs and a `probe`), reinstall-app
// (`tar-upload`), gather-workspace-data (`directory`), flow-read-prerequisite
// (an own-template `file` and a derived one with `skipWhenSet`), flow-execute.
const definitions = new Map<string, Pick<ToolDefinition<unknown, unknown>, "fileInputs">>();
const registry = {
  getTool: (id: string) => definitions.get(id),
} as unknown as Registry;
for (const def of [
  screenshotDiffTool,
  reinstallAppTool,
  gatherWorkspaceDataTool,
  flowReadPrerequisiteTool,
  createRunFlowTool(registry),
] as ToolDefinition<unknown, unknown>[]) {
  definitions.set(def.id, def);
}
// An own-template `file` input another param supersedes.
definitions.set("superseded-input", {
  fileInputs: [{ target: "imagePath", path: "${imagePath}", kind: "file", skipWhenSet: "image" }],
});

type ReadFile = (filePath: string) => Promise<Buffer | null>;

function project(mode: "host" | "client", readFile: ReadFile = async () => null) {
  const access = {
    mode,
    resolveFlowFile: vi.fn(async () => {
      throw new Error("resolveFlowFile is not part of a tool: step");
    }),
    readFile: vi.fn(readFile),
    writeBaseline: vi.fn(async () => {
      throw new Error("writeBaseline is not part of a tool: step");
    }),
  } satisfies ProjectAccess;
  return access;
}

/**
 * The files a client sent with a call that runs a nested flow-execute, behind
 * the real {@link ClientProjectAccess}: each flow by the path the step spells
 * (`<project_root>/.argent/flows/<name>.yaml`), keyed as the runner looks it
 * up. `canonical` is the client's real path (a symlinked project root), a
 * flow without `text` is one the client does not have, and `refused` the
 * reason it gave for not sending it.
 */
function nestedFlowClient(
  asked: Record<
    string,
    { canonical?: string; text?: string; spelling?: OnDiskSpelling; refused?: string }
  >
): ClientProjectAccess {
  const members: Record<string, ResolvedMember> = {};
  for (const [spelled, entry] of Object.entries(asked)) {
    members[flowMemberKey(path.posix.dirname(spelled), path.posix.basename(spelled))] = {
      role: "flow",
      state:
        entry.refused !== undefined ? "refused" : entry.text === undefined ? "missing" : "present",
      canonical: entry.canonical ?? spelled,
      spelling: entry.spelling ?? { state: "listed" },
      ...(entry.text === undefined ? {} : { text: entry.text }),
      ...(entry.refused === undefined ? {} : { error: entry.refused }),
    };
  }
  return new ClientProjectAccess(members);
}

let scratch = "";
let restoreTmpdir: () => void = () => {};
// Whatever a test keeps from prepareToolStepInputs it must clean up, as the
// runner does once the tool settles; this catches the ones a failing
// assertion skipped.
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  // A private tmpdir: the resolver writes there, and listing it proves what is
  // left behind without seeing the temp files of a concurrent suite.
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-tool-inputs-")));
  restoreTmpdir = redirectTmpdir(scratch);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  restoreTmpdir();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

async function inputTempDirs(): Promise<string[]> {
  return (await fs.readdir(scratch)).filter((entry) => entry.startsWith("argent-file-input-"));
}

/** A file on THIS host, outside the resolver's temp dirs. */
async function hostFile(name: string, bytes: Buffer): Promise<string> {
  const dir = path.join(scratch, "host");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

function fileOf(tool: string, args: Record<string, unknown>, target: string): ToolStepFile {
  const file = toolStepFilePaths(registry, tool, args).find((f) => f.spec.target === target);
  if (!file) throw new Error(`no file input ${target} of ${tool} for ${JSON.stringify(args)}`);
  return file;
}

describe("prepareToolStepInputs", () => {
  it("passes the args through in host mode", async () => {
    const host = project("host");
    const args = { udid: "sim-1", baselinePath: "/client/proj/base.png", captureCurrent: true };

    const prepared = await prepareToolStepInputs(registry, host, "screenshot-diff", args);

    expect(prepared.args).toBe(args);
    expect(prepared).not.toHaveProperty("fileInputs");
    expect(host.readFile).not.toHaveBeenCalled();
    await prepared.cleanup();
    expect(await inputTempDirs()).toEqual([]);
  });

  it("reads the flow a flow-execute names by name from the files the client sent into a flow_file temp file", async () => {
    const text = "steps:\n  - echo: from the client\n";
    const client = nestedFlowClient({ "/client/proj/.argent/flows/login.yaml": { text } });
    const args = { name: "login", project_root: "/client/proj", device: "sim-1" };

    const prepared = await prepareToolStepInputs(registry, client, "flow-execute", args);
    cleanups.push(prepared.cleanup);

    const served = prepared.args.flow_file as string;
    expect(path.dirname(path.dirname(served))).toBe(scratch);
    expect(path.basename(path.dirname(served))).toMatch(/^argent-file-input-/);
    expect(path.basename(served)).toBe("login.yaml");
    expect(await fs.readFile(served, "utf8")).toBe(text);
    // The nested run gets the step's own args, plus the uploaded flow.
    expect(prepared.args).toEqual({ ...args, flow_file: served });
    // And the files of the call itself, the same object, so it finds its own
    // files there and shares the call's baseline overlay.
    expect(prepared.fileInputs).toEqual({
      flow_file: {
        clientPath: "/client/proj/.argent/flows/login.yaml",
        presentOnHost: false,
        viaUpload: true,
        canonical: "/client/proj/.argent/flows/login.yaml",
        spelling: { state: "listed" },
        members: client.members,
      },
    });
    expect(prepared.fileInputs?.flow_file?.members).toBe(client.members);
    expect(args).not.toHaveProperty("flow_file");

    await prepared.cleanup();
    expect(await inputTempDirs()).toEqual([]);
  });

  it("writes a non-ASCII nested flow byte for byte, sized by its UTF-8 bytes", async () => {
    const text = "steps:\n  - echo: zażółć gęślą jaźń 🚀\n";
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(text.length);
    const client = nestedFlowClient({ "/client/proj/.argent/flows/login.yaml": { text } });

    // The resolver refuses an upload whose size is not its decoded byte count,
    // so a size in characters fails the step here.
    const prepared = await prepareToolStepInputs(registry, client, "flow-execute", {
      name: "login",
      project_root: "/client/proj",
    });
    cleanups.push(prepared.cleanup);

    expect(await fs.readFile(prepared.args.flow_file as string)).toEqual(Buffer.from(text, "utf8"));
  });

  it("names the path the step names as clientPath, and the client's real path as canonical", async () => {
    const client = nestedFlowClient({
      "/client/proj/.argent/flows/login.yaml": {
        canonical: "/client/real/.argent/flows/login.yaml",
        text: "steps: []\n",
      },
    });

    const prepared = await prepareToolStepInputs(registry, client, "flow-execute", {
      name: "login",
      project_root: "/client/proj",
    });
    cleanups.push(prepared.cleanup);

    expect(await fs.readFile(prepared.args.flow_file as string, "utf8")).toBe("steps: []\n");
    expect(prepared.fileInputs?.flow_file).toMatchObject({
      clientPath: "/client/proj/.argent/flows/login.yaml",
      canonical: "/client/real/.argent/flows/login.yaml",
    });
  });

  it("uses the client copy of a nested flow even when this host has another file at the same path", async () => {
    const projectRoot = path.join(scratch, "proj");
    const hostFlow = path.join(projectRoot, ".argent", "flows", "login.yaml");
    await fs.mkdir(path.dirname(hostFlow), { recursive: true });
    // Same size, so the host file would pass a size-only stat probe as well.
    await fs.writeFile(hostFlow, "steps:\n  - echo: SERVER\n");
    const client = nestedFlowClient({ [hostFlow]: { text: "steps:\n  - echo: CLIENT\n" } });

    const prepared = await prepareToolStepInputs(registry, client, "flow-execute", {
      name: "login",
      project_root: projectRoot,
    });
    cleanups.push(prepared.cleanup);

    expect(prepared.args.flow_file).not.toBe(hostFlow);
    expect(await fs.readFile(prepared.args.flow_file as string, "utf8")).toBe(
      "steps:\n  - echo: CLIENT\n"
    );
    expect(prepared.fileInputs?.flow_file).toMatchObject({ clientPath: hostFlow, viaUpload: true });
    expect(await fs.readFile(hostFlow, "utf8")).toBe("steps:\n  - echo: SERVER\n");
  });

  it("fails a nested flow the client does not have with the ENOENT of a host read, at the client's real path, and never reads the host file", async () => {
    const projectRoot = path.join(scratch, "proj");
    const hostFlow = path.join(projectRoot, ".argent", "flows", "login.yaml");
    await fs.mkdir(path.dirname(hostFlow), { recursive: true });
    await fs.writeFile(hostFlow, "steps: []\n");
    const client = nestedFlowClient({
      [hostFlow]: { canonical: "/client/real/.argent/flows/login.yaml" },
    });

    const failure = await prepareToolStepInputs(registry, client, "flow-execute", {
      name: "login",
      project_root: projectRoot,
    }).then(
      () => undefined,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "ENOENT: no such file or directory, open '/client/real/.argent/flows/login.yaml'"
    );
    expect(await inputTempDirs()).toEqual([]);
  });

  it("refuses a nested flow the client has only under a name that differs in case, as a run without a link does", async () => {
    const client = nestedFlowClient({
      "/client/proj/.argent/flows/Login.yaml": {
        canonical: "/client/proj/.argent/flows/login.yaml",
        spelling: { state: "case_folded", actual: "login.yaml", addressable: true },
        text: "steps: []\n",
      },
    });

    const failure = await prepareToolStepInputs(registry, client, "flow-execute", {
      name: "Login",
      project_root: "/client/proj",
    }).then(
      () => undefined,
      (err: unknown) => err
    );

    expect(getFailureSignal(failure)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_NAME_INVALID,
      failure_stage: "flow_name_casing",
    });
    expect((failure as Error).message).toContain('Invalid flow name "Login"');
    expect((failure as Error).message).toContain('Pass name "login".');
    expect(await inputTempDirs()).toEqual([]);
  });

  it("fails a nested flow the client refused to send with its reason, and one it did not send at all", async () => {
    const refusedBy = nestedFlowClient({
      "/client/proj/.argent/flows/login.yaml": {
        refused: "login.yaml is outside every root this client serves (/client/other)",
      },
    });
    const refused = await prepareToolStepInputs(registry, refusedBy, "flow-execute", {
      name: "login",
      project_root: "/client/proj",
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(getFailureSignal(refused)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "client_member_refused",
    });
    expect((refused as Error).message).toBe(
      'the client refused to send "login.yaml": login.yaml is outside every root this client ' +
        "serves (/client/other)"
    );

    const unsent = await prepareToolStepInputs(registry, nestedFlowClient({}), "flow-execute", {
      name: "login",
      project_root: "/client/proj",
    }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect((unsent as Error).message).toBe(
      'the client refused to send "login.yaml": login.yaml is not a run: target of a flow this ' +
        "client sent"
    );
    expect(await inputTempDirs()).toEqual([]);
  });

  it("passes flow-execute args in any other form through in client mode", async () => {
    const forms: Record<string, unknown>[] = [
      { flow_path: "/client/proj/.argent/flows/login.yaml", udid: "sim-1" },
      { name: "login", project_root: "proj" },
      { name: "login", project_root: "/client/../proj" },
      { name: "login" },
      { name: "../login", project_root: "/client/proj" },
      { name: "login.yaml", project_root: "/client/proj" },
      { name: "login", project_root: "/client/proj", flow_path: "/client/x.yaml" },
      {},
    ];
    for (const args of forms) {
      const client = nestedFlowClient({
        "/client/proj/.argent/flows/login.yaml": { text: "steps: []\n" },
      });

      const prepared = await prepareToolStepInputs(registry, client, "flow-execute", args);

      expect(prepared.args, JSON.stringify(args)).toBe(args);
      expect(prepared, JSON.stringify(args)).not.toHaveProperty("fileInputs");
    }
    expect(await inputTempDirs()).toEqual([]);
  });

  it("passes flow-execute args through in host mode, by name or by flow_path", async () => {
    for (const args of [
      { name: "login", project_root: "/client/proj" },
      { flow_path: "/client/proj/.argent/flows/login.yaml" },
    ]) {
      const host = project("host");

      const prepared = await prepareToolStepInputs(registry, host, "flow-execute", args);

      expect(prepared.args).toBe(args);
      expect(prepared).not.toHaveProperty("fileInputs");
      expect(host.resolveFlowFile).not.toHaveBeenCalled();
      expect(host.readFile).not.toHaveBeenCalled();
    }
    expect(await inputTempDirs()).toEqual([]);
  });

  it("passes the args through in client mode when no file input applies", async () => {
    const client = project("client", async () => Buffer.from("x"));
    const unknownTool = { x: 0.5, y: 0.5, udid: "sim-1" };
    const liveOnly = { udid: "sim-1", captureBaseline: true, captureCurrent: true };

    const forUnknown = await prepareToolStepInputs(registry, client, "gesture-tap", unknownTool);
    const forLive = await prepareToolStepInputs(registry, client, "screenshot-diff", liveOnly);

    expect(forUnknown.args).toBe(unknownTool);
    expect(forLive.args).toBe(liveOnly);
    expect(client.readFile).not.toHaveBeenCalled();
  });

  it("wraps a file input with content from the client and resolves it to a temp file", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const client = project("client", async () => bytes);
    const args = {
      udid: "sim-1",
      baselinePath: "/client/proj/shots/base line.png",
      captureCurrent: true,
      rotation: "Portrait",
    };

    const prepared = await prepareToolStepInputs(registry, client, "screenshot-diff", args);
    cleanups.push(prepared.cleanup);

    expect(client.readFile.mock.calls).toEqual([["/client/proj/shots/base line.png"]]);
    const served = prepared.args.baselinePath as string;
    expect(path.dirname(path.dirname(served))).toBe(scratch);
    expect(path.basename(path.dirname(served))).toMatch(/^argent-file-input-/);
    expect(await fs.readFile(served)).toEqual(bytes);
    expect(prepared.args).toEqual({ ...args, baselinePath: served });
    expect(prepared.fileInputs).toEqual({
      baselinePath: {
        clientPath: "/client/proj/shots/base line.png",
        presentOnHost: false,
        viaUpload: true,
      },
    });
    // The step keeps the client path the flow names; only the invoke gets the copy.
    expect(args.baselinePath).toBe("/client/proj/shots/base line.png");

    await prepared.cleanup();
    expect(await inputTempDirs()).toEqual([]);
  });

  it("resolves every file input of the step and removes them all on cleanup", async () => {
    const client = project("client", async (filePath) => Buffer.from(`bytes of ${filePath}`));
    const args = { baselinePath: "/client/a.png", currentPath: "/client/b.png" };

    const prepared = await prepareToolStepInputs(registry, client, "screenshot-diff", args);
    cleanups.push(prepared.cleanup);

    expect(await fs.readFile(prepared.args.baselinePath as string, "utf8")).toBe(
      "bytes of /client/a.png"
    );
    expect(await fs.readFile(prepared.args.currentPath as string, "utf8")).toBe(
      "bytes of /client/b.png"
    );
    expect(Object.keys(prepared.fileInputs ?? {}).sort()).toEqual(["baselinePath", "currentPath"]);
    expect(await inputTempDirs()).toHaveLength(2);

    await prepared.cleanup();
    expect(await inputTempDirs()).toEqual([]);
  });

  it("uses the client bytes even when the server has a file at the same path", async () => {
    // Same size, so the host file would pass a size-only stat probe as well.
    const shared = await hostFile("base.png", Buffer.from("SERVER"));
    const client = project("client", async () => Buffer.from("CLIENT"));

    const prepared = await prepareToolStepInputs(registry, client, "screenshot-diff", {
      baselinePath: shared,
      captureCurrent: true,
    });
    cleanups.push(prepared.cleanup);

    expect(client.readFile).toHaveBeenCalledWith(shared);
    expect(prepared.args.baselinePath).not.toBe(shared);
    expect(await fs.readFile(prepared.args.baselinePath as string, "utf8")).toBe("CLIENT");
    expect(prepared.fileInputs?.baselinePath).toMatchObject({
      clientPath: shared,
      viaUpload: true,
    });
    expect(await fs.readFile(shared, "utf8")).toBe("SERVER");
  });

  it("fails a missing client file with a reason that names the client, and never uses a server file at that path", async () => {
    const shared = await hostFile("base.png", Buffer.from("SERVER"));
    const client = project("client", async () => null);

    const failure = await prepareToolStepInputs(registry, client, "screenshot-diff", {
      baselinePath: shared,
      captureCurrent: true,
    }).then(
      () => undefined,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(FileInputError);
    expect((failure as Error).message).toBe(
      `the client has no file at "${shared}" (argument baselinePath of screenshot-diff)`
    );
    expect(client.readFile).toHaveBeenCalledOnce();
    expect(await inputTempDirs()).toEqual([]);
  });

  it("skips a spec whose template names an absent parameter", async () => {
    expect(
      toolStepFilePaths(registry, "screenshot-diff", {
        baselinePath: "/client/a.png",
        currentPath: "",
        outputDir: 7,
      }).map((f) => [f.spec.target, f.path])
    ).toEqual([["baselinePath", "/client/a.png"]]);
    // flow_file needs both project_root and name.
    expect(toolStepFilePaths(registry, "flow-read-prerequisite", { name: "login" })).toEqual([]);

    const client = project("client", async () => Buffer.from("png"));
    const prepared = await prepareToolStepInputs(registry, client, "screenshot-diff", {
      currentPath: "/client/b.png",
      captureBaseline: true,
    });
    cleanups.push(prepared.cleanup);
    expect(client.readFile.mock.calls).toEqual([["/client/b.png"]]);
    expect(Object.keys(prepared.fileInputs ?? {})).toEqual(["currentPath"]);
  });

  it("skips a spec whose skipWhenSet parameter is set", async () => {
    const derived = { project_root: "/client/proj", name: "login" };
    expect(
      toolStepFilePaths(registry, "flow-read-prerequisite", derived).map((f) => [
        f.spec.target,
        f.path,
      ])
    ).toEqual([["flow_file", "/client/proj/.argent/flows/login.yaml"]]);
    expect(
      toolStepFilePaths(registry, "flow-read-prerequisite", {
        ...derived,
        flow_path: "/client/other.yaml",
      }).map((f) => f.spec.target)
    ).toEqual(["flow_path"]);
    // Set means provided: an empty superseding value still skips the spec.
    expect(
      toolStepFilePaths(registry, "flow-read-prerequisite", { ...derived, flow_path: "" })
    ).toEqual([]);

    const client = project("client", async () => Buffer.from("png"));
    const args = { imagePath: "/client/a.png", image: "inline" };
    const prepared = await prepareToolStepInputs(registry, client, "superseded-input", args);
    expect(prepared.args).toBe(args);
    expect(client.readFile).not.toHaveBeenCalled();
  });

  it("leaves an input whose unwrapWhenSet parameter is set as the client path, unread", async () => {
    // name and flow_path together: the tool's own exactly-one check reports
    // it, as for an HTTP call, before any file is read from the client.
    const client = project("client", async () => Buffer.from("steps: []"));
    const args = { project_root: "/client/proj", name: "login", flow_path: "/client/x.yaml" };

    const prepared = await prepareToolStepInputs(registry, client, "flow-read-prerequisite", args);

    expect(prepared.args).toBe(args);
    expect(client.readFile).not.toHaveBeenCalled();
    expect(await inputTempDirs()).toEqual([]);
  });

  it("refuses an input the client cannot send, without asking the client", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["screenshot-diff", { baselinePath: "shots/base.png" }, "baselinePath", "shots/base.png"],
      ["screenshot-diff", { outputDir: "/client/out" }, "outputDir", "/client/out"],
      [
        "reinstall-app",
        { udid: "sim-1", appPath: "/client/App.app" },
        "appPath",
        "/client/App.app",
      ],
      ["gather-workspace-data", { workspacePath: "/client/proj" }, "workspacePath", "/client/proj"],
      [
        "flow-read-prerequisite",
        { project_root: "/client/proj", name: "login" },
        "flow_file",
        "/client/proj/.argent/flows/login.yaml",
      ],
    ];
    for (const [tool, args, target, filePath] of cases) {
      const client = project("client", async () => Buffer.from("x"));
      const failure = await prepareToolStepInputs(registry, client, tool, args).then(
        () => undefined,
        (err: unknown) => err
      );
      expect(failure).toBeInstanceOf(FileInputError);
      expect((failure as Error).message).toBe(
        `"${filePath}" (argument ${target} of ${tool}) cannot be read from the client`
      );
      expect(client.readFile).not.toHaveBeenCalled();
    }
    expect(await inputTempDirs()).toEqual([]);
  });

  it("propagates a refusal from the client unchanged and leaves no temp file behind", async () => {
    const refusal = new FailureError(`"/client/b.png" is outside every root the client serves`, {
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "client_member_refused",
      failure_area: "tool_server",
      error_kind: "validation",
    });
    const client = project("client", async (filePath) => {
      if (filePath === "/client/a.png") return Buffer.from("first");
      throw refusal;
    });

    await expect(
      prepareToolStepInputs(registry, client, "screenshot-diff", {
        baselinePath: "/client/a.png",
        currentPath: "/client/b.png",
      })
    ).rejects.toBe(refusal);

    expect(client.readFile.mock.calls).toEqual([["/client/a.png"], ["/client/b.png"]]);
    expect(getFailureSignal(refusal)?.failure_stage).toBe("client_member_refused");
    expect(await inputTempDirs()).toEqual([]);
  });
});

describe("prepareToolStepInputs with the files a client sent", () => {
  it("hands the tool a baseline an earlier step of the call wrote, not the copy the client sent", async () => {
    const sentCopy = await hostFile("page.png", Buffer.from("old baseline"));
    const baseline = "/client/.argent/flows/__baselines__/raw/page__chromium-1000x713.png";
    const client = new ClientProjectAccess({
      [baseline]: { role: "tool", state: "present", hostPath: sentCopy },
    });
    await client.writeBaseline(baseline, Buffer.from("new baseline"));

    const prepared = await prepareToolStepInputs(registry, client, "screenshot-diff", {
      baselinePath: baseline,
    });
    cleanups.push(prepared.cleanup);

    expect(await fs.readFile(String(prepared.args.baselinePath), "utf8")).toBe("new baseline");
    expect(prepared.fileInputs?.baselinePath).toMatchObject({
      clientPath: baseline,
      viaUpload: true,
    });
  });
});

describe("servedToolInput", () => {
  it("serves a file input only with the files sent with the call, and never a probe, directory, tar-upload, derived or relative input", () => {
    const baseline = fileOf("screenshot-diff", { baselinePath: "/client/a.png" }, "baselinePath");
    const flowPath = fileOf(
      "flow-read-prerequisite",
      { flow_path: "/client/proj/.argent/flows/login.yaml" },
      "flow_path"
    );

    expect(servedToolInput(baseline, true)).toBe(true);
    expect(servedToolInput(flowPath, true)).toBe(true);
    // The extension in any case, as the client matches it.
    expect(
      servedToolInput(
        fileOf("screenshot-diff", { baselinePath: "/client/A.PNG" }, "baselinePath"),
        true
      )
    ).toBe(true);

    // A client that sends no files with the call carries none.
    expect(servedToolInput(baseline, false)).toBe(false);

    const neverServed: ToolStepFile[] = [
      fileOf("screenshot-diff", { outputDir: "/client/out" }, "outputDir"),
      fileOf("gather-workspace-data", { workspacePath: "/client/proj" }, "workspacePath"),
      fileOf("reinstall-app", { appPath: "/client/App.app" }, "appPath"),
      fileOf(
        "flow-read-prerequisite",
        { project_root: "/client/proj", name: "login" },
        "flow_file"
      ),
      fileOf("screenshot-diff", { baselinePath: "shots/a.png" }, "baselinePath"),
      fileOf("screenshot-diff", { baselinePath: "~/shots/a.png" }, "baselinePath"),
      // A name the client never sends.
      fileOf("screenshot-diff", { baselinePath: "/client/a.webp" }, "baselinePath"),
      fileOf("screenshot-diff", { baselinePath: "/client/a.json" }, "baselinePath"),
    ];
    for (const file of neverServed) {
      expect(servedToolInput(file, true), `${file.spec.target} ${file.path}`).toBe(false);
    }
  });
});

describe("refusedToolInputFix", () => {
  it("asks for an update for an absolute file argument, an absolute path for a relative one, and a served name for another", () => {
    expect(
      refusedToolInputFix(
        fileOf("screenshot-diff", { currentPath: "/client/b.png" }, "currentPath")
      )
    ).toBe("update");
    expect(
      refusedToolInputFix(
        fileOf("flow-read-prerequisite", { flow_path: "/client/login.yaml" }, "flow_path")
      )
    ).toBe("update");
    expect(
      refusedToolInputFix(fileOf("screenshot-diff", { currentPath: "shots/b.png" }, "currentPath"))
    ).toBe("relative");
    expect(
      refusedToolInputFix(fileOf("screenshot-diff", { baselinePath: "./b.png" }, "baselinePath"))
    ).toBe("relative");
    expect(
      refusedToolInputFix(
        fileOf("screenshot-diff", { baselinePath: "/client/b.webp" }, "baselinePath")
      )
    ).toBe("extension");
  });

  it("has no fix for an input no client can send", () => {
    const noFix: ToolStepFile[] = [
      fileOf("screenshot-diff", { outputDir: "/client/out" }, "outputDir"),
      fileOf("screenshot-diff", { outputDir: "out" }, "outputDir"),
      fileOf("gather-workspace-data", { workspacePath: "/client/proj" }, "workspacePath"),
      fileOf("reinstall-app", { appPath: "/client/App.app" }, "appPath"),
      fileOf("reinstall-app", { appPath: "App.app" }, "appPath"),
      fileOf(
        "flow-read-prerequisite",
        { project_root: "/client/proj", name: "login" },
        "flow_file"
      ),
      fileOf("flow-read-prerequisite", { project_root: "proj", name: "login" }, "flow_file"),
    ];
    for (const file of noFix) {
      expect(refusedToolInputFix(file), `${file.spec.target} ${file.path}`).toBeUndefined();
    }
  });
});

describe("toolStepUploadIssue", () => {
  const byName = { name: "login", project_root: "/client/proj" };

  it("runs a flow-execute that names its flow by name with an absolute project_root when the call came with its files", () => {
    expect(toolStepUploadIssue(registry, "flow-execute", byName, true)).toBeUndefined();
    expect(
      toolStepUploadIssue(registry, "flow-execute", { ...byName, udid: "sim-1" }, true)
    ).toBeUndefined();
  });

  it("refuses a flow-execute by name when the call came without files, as a nested step with no fix", () => {
    expect(toolStepUploadIssue(registry, "flow-execute", byName, false)).toEqual({
      kind: "nested",
      line: "tool: flow-execute (name: login)",
      fixes: [],
    });
  });

  it("refuses a flow-execute in any other form, also when the call came with its files", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { flow_path: "/client/proj/.argent/flows/login.yaml" },
        "tool: flow-execute (flow_path: /client/proj/.argent/flows/login.yaml)",
      ],
      [{ name: "login", project_root: "proj" }, "tool: flow-execute (name: login)"],
      [{ name: "login", project_root: "/client/../proj" }, "tool: flow-execute (name: login)"],
      [{ name: "login" }, "tool: flow-execute (name: login)"],
      [{ ...byName, flow_path: "/client/x.yaml" }, "tool: flow-execute (name: login)"],
      [{}, "tool: flow-execute"],
    ];
    for (const [args, line] of cases) {
      for (const withFiles of [true, false]) {
        expect(
          toolStepUploadIssue(registry, "flow-execute", args, withFiles),
          `${JSON.stringify(args)} ${withFiles}`
        ).toEqual({ kind: "nested", line, fixes: [] });
      }
    }
  });

  it("runs another tool's absolute .png or .yaml file argument when the call came with its files", () => {
    expect(
      toolStepUploadIssue(
        registry,
        "screenshot-diff",
        { baselinePath: "/client/a.png", currentPath: "/client/B.PNG" },
        true
      )
    ).toBeUndefined();
    expect(
      toolStepUploadIssue(
        registry,
        "flow-read-prerequisite",
        { flow_path: "/client/proj/.argent/flows/login.yaml" },
        true
      )
    ).toBeUndefined();
    // A tool with no file input runs for every client.
    expect(toolStepUploadIssue(registry, "gesture-tap", { x: 0.5 }, false)).toBeUndefined();
  });

  it("refuses a file argument of a call without files, with the update fix", () => {
    expect(
      toolStepUploadIssue(registry, "screenshot-diff", { baselinePath: "/client/a.png" }, false)
    ).toEqual({
      kind: "toolFile",
      line: "tool: screenshot-diff (/client/a.png)",
      fixes: ["update"],
    });
  });

  it("asks for an absolute path for a relative file argument, and a sent name for another extension", () => {
    expect(
      toolStepUploadIssue(registry, "screenshot-diff", { baselinePath: "shots/a.png" }, true)
    ).toEqual({
      kind: "toolFile",
      line: "tool: screenshot-diff (shots/a.png)",
      fixes: ["relative"],
    });
    expect(
      toolStepUploadIssue(registry, "screenshot-diff", { currentPath: "/client/b.json" }, true)
    ).toEqual({
      kind: "toolFile",
      line: "tool: screenshot-diff (/client/b.json)",
      fixes: ["extension"],
    });
  });

  it("refuses a directory, an app, an output directory or a path built from several arguments with no fix", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["gather-workspace-data", { workspacePath: "/client/proj" }, "/client/proj"],
      ["reinstall-app", { udid: "sim-1", appPath: "/client/App.app" }, "/client/App.app"],
      ["screenshot-diff", { outputDir: "/client/out" }, "/client/out"],
      ["flow-read-prerequisite", byName, "/client/proj/.argent/flows/login.yaml"],
    ];
    for (const [tool, args, refused] of cases) {
      expect(toolStepUploadIssue(registry, tool, args, true), tool).toEqual({
        kind: "toolFile",
        line: `tool: ${tool} (${refused})`,
        fixes: [],
      });
    }
  });

  it("lists only the refused paths, in the order of the tool's file inputs, with each fix once", () => {
    expect(
      toolStepUploadIssue(
        registry,
        "screenshot-diff",
        { baselinePath: "/client/a.png", currentPath: "shots/b.png", outputDir: "/client/out" },
        true
      )
    ).toEqual({
      kind: "toolFile",
      line: "tool: screenshot-diff (shots/b.png, /client/out)",
      fixes: ["relative"],
    });
    expect(
      toolStepUploadIssue(
        registry,
        "screenshot-diff",
        { baselinePath: "a.png", currentPath: "b.png" },
        true
      )
    ).toEqual({
      kind: "toolFile",
      line: "tool: screenshot-diff (a.png, b.png)",
      fixes: ["relative"],
    });
    expect(
      toolStepUploadIssue(
        registry,
        "screenshot-diff",
        { baselinePath: "/client/a.webp", currentPath: "shots/b.png", outputDir: "/client/out" },
        false
      )
    ).toEqual({
      kind: "toolFile",
      line: "tool: screenshot-diff (/client/a.webp, shots/b.png, /client/out)",
      fixes: ["extension", "relative"],
    });
  });
});

describe("toolFilePathHints", () => {
  const RELATIVE = " Over a link, a tool: step must name a file by an absolute path.";
  const EXTENSION = " Over a link, a tool: step can name only a .png or .yaml file.";

  it("says how to name a refused file argument, once per fix, relative first", () => {
    expect(toolFilePathHints([])).toBe("");
    expect(toolFilePathHints(["update"])).toBe("");
    expect(toolFilePathHints(["relative"])).toBe(RELATIVE);
    expect(toolFilePathHints(["extension"])).toBe(EXTENSION);
    expect(toolFilePathHints(["extension", "relative", "extension", "update"])).toBe(
      RELATIVE + EXTENSION
    );
    expect(toolFilePathHints(new Set(["extension", "relative"] as const))).toBe(
      RELATIVE + EXTENSION
    );
  });
});

describe("uploadUpdateHint", () => {
  it("names what this tool-server runs for a newer client, or nothing", () => {
    expect(uploadUpdateHint([])).toBe("");
    expect(
      uploadUpdateHint(["run: steps for a client that sends their fragments with the call"])
    ).toBe(
      " This tool-server runs run: steps for a client that sends their fragments with the call. " +
        "Update the argent CLI or MCP adapter on the client."
    );
    expect(uploadUpdateHint(["a", "b", "c"])).toBe(
      " This tool-server runs a, and b, and c. Update the argent CLI or MCP adapter on the client."
    );
  });
});
