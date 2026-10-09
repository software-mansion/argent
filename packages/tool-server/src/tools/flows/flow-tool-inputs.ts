import * as path from "node:path";
import {
  FILE_INPUT_MARKER,
  isClientFileArgument,
  nestedFlowTarget,
  toolStepFiles,
  type FileInputWire,
  type Registry,
  type ResolvedFileInput,
  type ToolStepFile,
} from "@argent/registry";
import { FileInputError, resolveFileInputs } from "../../file-inputs";
import { flowNameCasingError } from "./flow-utils";
import { ClientProjectAccess, type ProjectAccess } from "./project-access";

/** The stage each step kind an upload cannot carry is refused under. */
export const UPLOAD_STAGE_BY_KIND = {
  run: "flow_upload_run_composition",
  script: "flow_upload_script_step",
  snapshot: "flow_upload_snapshot_baseline",
  nested: "flow_upload_nested_flow",
  toolFile: "flow_upload_tool_file_input",
  recording: "flow_upload_recording_tool",
} as const;

/** The flow a nested `tool: flow-execute` step names, quoted in the refusal's step list. */
function nestedFlowRef(args: Record<string, unknown>): string {
  if (typeof args.name === "string") return ` (name: ${args.name})`;
  if (typeof args.flow_path === "string") return ` (flow_path: ${args.flow_path})`;
  return "";
}

/** The file inputs a `tool:` step's args fill in for the tool it names ({@link toolStepFiles}). */
function toolStepFilePaths(
  registry: Registry,
  tool: string,
  args: Record<string, unknown>
): ToolStepFile[] {
  return toolStepFiles(registry.getTool(tool)?.fileInputs, args);
}

/**
 * A `file` input whose path is one argument of the step, as written (not a
 * path the tool builds out of several, such as `flow_file`).
 */
function isFileArgument({ spec }: ToolStepFile): boolean {
  return spec.kind === "file" && spec.path === `\${${spec.target}}`;
}

/**
 * Whether a `tool:` step's file input runs over a link: a file argument the
 * client sends with the call ({@link isClientFileArgument}), when the call
 * came with the flow's files (`withFiles`). A directory, an app bundle and
 * `screenshot-diff`'s `outputDir` do not travel with the call, so a step that
 * fills one stays refused for every client.
 */
function servedToolInput(file: ToolStepFile, withFiles: boolean): boolean {
  return isClientFileArgument(file) && withFiles;
}

/**
 * Why a refused file input of a `tool:` step would run with a different client
 * or path, or undefined: `update` when only the files sent with the call are
 * missing, `relative` when the path is relative, `extension` when its name is
 * not one the client sends.
 */
export function refusedToolInputFix(
  file: ToolStepFile
): "update" | "relative" | "extension" | undefined {
  if (isClientFileArgument(file)) return "update";
  if (!isFileArgument(file)) return undefined;
  return path.posix.isAbsolute(file.path) ? "extension" : "relative";
}

/** Why a refused file input of a `tool:` step would run with a different client or path. */
export type ToolFileFix = NonNullable<ReturnType<typeof refusedToolInputFix>>;

/**
 * Why a run over a link refuses a `tool:` step, or undefined when it runs it.
 * One rule for the up-front check of an uploaded flow and for the recorder
 * over a link. `withFiles`: the call came with the files of its flow or of
 * its step. `nested`: a `tool: flow-execute` step, which runs only with those
 * files and only when it names its flow with `name` and an absolute
 * `project_root` (`nestedFlowTarget`), the one form the client sends.
 * `toolFile`: a file input the client does not send ({@link servedToolInput});
 * `fixes` says which other client or path would carry it. `line` is the step
 * without its position. A recording tool is not judged here: the caller
 * refuses it on its own.
 */
export function toolStepUploadIssue(
  registry: Registry,
  tool: string,
  args: Record<string, unknown>,
  withFiles: boolean
): { kind: "nested" | "toolFile"; line: string; fixes: ToolFileFix[] } | undefined {
  if (tool === "flow-execute") {
    if (withFiles && nestedFlowTarget(args)?.kind === "name") return undefined;
    return { kind: "nested", line: `tool: flow-execute${nestedFlowRef(args)}`, fixes: [] };
  }
  const refused = toolStepFilePaths(registry, tool, args).filter(
    (file) => !servedToolInput(file, withFiles)
  );
  if (refused.length === 0) return undefined;
  const fixes = new Set<ToolFileFix>();
  for (const file of refused) {
    const fix = refusedToolInputFix(file);
    if (fix !== undefined) fixes.add(fix);
  }
  return {
    kind: "toolFile",
    line: `tool: ${tool} (${refused.map((file) => file.path).join(", ")})`,
    fixes: [...fixes],
  };
}

/** The sentences that say how to name a refused file argument so that it travels over a link. */
export function toolFilePathHints(fixes: Iterable<ToolFileFix>): string {
  const all = new Set(fixes);
  return [
    ...(all.has("relative")
      ? [" Over a link, a tool: step must name a file by an absolute path."]
      : []),
    ...(all.has("extension")
      ? [" Over a link, a tool: step can name only a .png or .yaml file."]
      : []),
  ].join("");
}

/** The sentence that tells a caller this tool-server runs `items` for a newer client. */
export function uploadUpdateHint(items: readonly string[]): string {
  return items.length > 0
    ? ` This tool-server runs ${items.join(", and ")}. Update the argent CLI or MCP adapter on the client.`
    : "";
}

export interface PreparedToolStep {
  /** The args to invoke the tool with: each served file argument is a path on this host. */
  args: Record<string, unknown>;
  fileInputs?: Record<string, ResolvedFileInput>;
  /** Removes the files written for the step. Call once the tool has settled. */
  cleanup: () => Promise<void>;
}

/**
 * `text` with each temp file of a prepared step named by the client path it
 * holds, so a reason the tool wrote names the file the flow names, not one
 * this host has already removed.
 */
export function withClientPaths(prepared: PreparedToolStep, text: string): string {
  let out = text;
  for (const [target, input] of Object.entries(prepared.fileInputs ?? {})) {
    const tempPath = prepared.args[target];
    if (typeof tempPath === "string" && input.viaUpload) {
      out = out.split(tempPath).join(input.clientPath);
    }
  }
  return out;
}

/**
 * The file boundary of an HTTP call, for a `tool:` step of a flow whose files
 * are on the client: each file argument is looked up in the files the client
 * sent with the call (a baseline this call wrote first), and written to a
 * temp file on this host by the resolver of an HTTP call, so the tool gets
 * the same paths and the same `ctx.fileInputs` as for a direct call. A file
 * the client does not have fails the step: a server file at the same path is
 * never used in its place. A `flow-execute` gets the flow it names by `name`
 * from those files instead ({@link prepareNestedFlow}). In host mode the args
 * pass through unchanged. An input whose `unwrapWhenSet` param is set stays
 * the client path, unread, as an HTTP call unwraps it: the tool's own
 * validation diagnoses the second source. The client skips such an input too.
 */
export async function prepareToolStepInputs(
  registry: Registry,
  project: ProjectAccess,
  toolId: string,
  args: Record<string, unknown>
): Promise<PreparedToolStep> {
  if (project instanceof ClientProjectAccess && toolId === "flow-execute") {
    return prepareNestedFlow(registry, project, args);
  }
  const files =
    project.mode === "client"
      ? toolStepFilePaths(registry, toolId, args).filter(
          ({ spec }) => spec.unwrapWhenSet === undefined || args[spec.unwrapWhenSet] === undefined
        )
      : [];
  if (files.length === 0) return { args, cleanup: async () => {} };
  const wrapped: Record<string, unknown> = { ...args };
  for (const file of files) {
    // Not reached: the upload gate refuses such an input before step 1.
    if (!isClientFileArgument(file)) {
      throw new FileInputError(
        `"${file.path}" (argument ${file.spec.target} of ${toolId}) cannot be read from the client`
      );
    }
    const bytes = await project.readFile(file.path);
    if (bytes === null) {
      throw new FileInputError(
        `the client has no file at "${file.path}" (argument ${file.spec.target} of ${toolId})`
      );
    }
    const wire: FileInputWire = {
      [FILE_INPUT_MARKER]: true,
      path: file.path,
      size: bytes.length,
      content: bytes.toString("base64"),
    };
    wrapped[file.spec.target] = wire;
  }
  const resolved = await resolveFileInputs({ fileInputs: files.map((f) => f.spec) }, wrapped);
  return {
    args: resolved.args,
    ...(resolved.fileInputs ? { fileInputs: resolved.fileInputs } : {}),
    cleanup: resolved.cleanup,
  };
}

/**
 * A nested `flow-execute` whose flow is on the client: the flow its `name`
 * names under its `project_root` is looked up in the files the client sent
 * with the call, and goes to the nested run as the `flow_file` upload of a
 * linked call, so the nested run reads the client copy, also when this host
 * has a file at the same path. The nested run gets the same files with it
 * (`members`), so it finds its own `run:` fragments, nested flows,
 * baselines and file arguments there, and it shares this call's baseline
 * overlay ({@link ClientProjectAccess}). A flow the client does not have, or
 * has only under a name that differs in case, fails with the error a run
 * without a link gives. Args in any other form pass through: the up-front
 * check refuses them before they run.
 */
async function prepareNestedFlow(
  registry: Registry,
  project: ClientProjectAccess,
  args: Record<string, unknown>
): Promise<PreparedToolStep> {
  const target = nestedFlowTarget(args);
  if (target?.kind !== "name") return { args, cleanup: async () => {} };
  const hop = await project.resolveFlowFile(path.dirname(target.path), `${target.name}.yaml`);
  // Refused as a run without a link refuses it: the name keys the nested
  // run's report and baselines, and no entry on the client carries it.
  if (hop.spelling.state === "case_folded") throw flowNameCasingError(target.name, hop.spelling);
  const text = await hop.read();
  if (text === null) {
    throw new Error(`ENOENT: no such file or directory, open '${hop.canonical}'`);
  }
  // The resolver checks `size` against the decoded bytes, not the characters.
  const bytes = Buffer.from(text, "utf8");
  const wire: FileInputWire = {
    [FILE_INPUT_MARKER]: true,
    path: target.path,
    size: bytes.length,
    content: bytes.toString("base64"),
  };
  const resolved = await resolveFileInputs(
    { fileInputs: registry.getTool("flow-execute")?.fileInputs },
    { ...args, flow_file: wire }
  );
  const input = resolved.fileInputs?.flow_file;
  if (input) {
    input.canonical = hop.canonical;
    input.spelling = hop.spelling;
    input.members = project.members;
  }
  return {
    args: resolved.args,
    ...(resolved.fileInputs ? { fileInputs: resolved.fileInputs } : {}),
    cleanup: resolved.cleanup,
  };
}
