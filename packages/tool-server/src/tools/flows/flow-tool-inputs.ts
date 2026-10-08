import * as path from "node:path";
import {
  FILE_INPUT_MARKER,
  hasToolFileExtension,
  interpolateFileInputPath,
  nestedFlowTarget,
  type ClientServiceOp,
  type FileInputSpec,
  type FileInputWire,
  type Registry,
  type ResolvedFileInput,
} from "@argent/registry";
import { FileInputError, resolveFileInputs } from "../../file-inputs";
import { flowNameCasingError } from "./flow-utils";
import type { ProjectAccess } from "./project-access";

/**
 * The client-services ops of the tools that run a flow's steps: `flow-execute`
 * and `flow-add-step`. The client offers `write-file` only for a call that
 * updates baselines, so a `flow-add-step` call never gets it.
 */
export const FLOW_RUN_CLIENT_OPS: ClientServiceOp[] = ["resolve-file", "read-file", "write-file"];

/** The stage each step kind an upload cannot carry is refused under; each one is gated on what the client offered to serve. */
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

/** A file input a `tool:` step fills, and the path its args fill in. */
export interface ToolStepFile {
  spec: FileInputSpec;
  path: string;
}

/**
 * The file inputs a `tool:` step's args fill in for the tool it names: a spec
 * applies when every `${param}` it names is a non-empty string and no
 * superseding source is set, as when the client wraps a call.
 */
export function toolStepFilePaths(
  registry: Registry,
  tool: string,
  args: Record<string, unknown>
): ToolStepFile[] {
  const files: ToolStepFile[] = [];
  for (const spec of registry.getTool(tool)?.fileInputs ?? []) {
    if (spec.skipWhenSet !== undefined && args[spec.skipWhenSet] !== undefined) continue;
    const filled = interpolateFileInputPath(spec.path, args);
    if (filled !== null) files.push({ spec, path: filled });
  }
  return files;
}

/**
 * A `file` input whose path is one argument of the step, as written (not a
 * path the tool builds out of several, such as `flow_file`).
 */
function isFileArgument({ spec }: ToolStepFile): boolean {
  return spec.kind === "file" && spec.path === `\${${spec.target}}`;
}

/**
 * A file the client can send for a `tool:` step: a file argument
 * ({@link isFileArgument}) at an absolute path with a name the registry's
 * `hasToolFileExtension` accepts. The client serves exactly those paths: the
 * ones a `tool:` step of a flow it served names.
 */
function isClientFileArgument(file: ToolStepFile): boolean {
  return (
    isFileArgument(file) && path.posix.isAbsolute(file.path) && hasToolFileExtension(file.path)
  );
}

/**
 * Whether a `tool:` step's file input runs over a link: a file argument the
 * client sends ({@link isClientFileArgument}) when it offers `read-file`. A
 * directory, an app bundle and `screenshot-diff`'s `outputDir` have no op that
 * carries them, so a step that fills one stays refused for every client.
 */
export function servedToolInput(
  file: ToolStepFile,
  offeredOps: readonly ClientServiceOp[] | undefined
): boolean {
  return isClientFileArgument(file) && (offeredOps?.includes("read-file") ?? false);
}

/**
 * Why a refused file input of a `tool:` step would run with a different client
 * or path, or undefined: `update` when only the `read-file` op is missing,
 * `relative` when the path is relative, `extension` when its name is not one
 * the client serves.
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
 * Why a replay over a link refuses a `tool:` step, or undefined when it runs
 * it. One rule for the up-front check of an uploaded flow and for the recorder
 * over a link. `nested`: a `tool: flow-execute` step, which runs only when the
 * client offers `resolve-file` and the step names its flow with `name` and an
 * absolute `project_root` (`nestedFlowTarget`), the one form the client
 * serves. `toolFile`: a file input the client does not send
 * ({@link servedToolInput}); `fixes` says which other client or path would
 * carry it. `line` is the step without its position. A recording tool is not
 * judged here: the caller refuses it on its own. `servesNestedFlows` is false
 * for a client that offers `resolve-file` but does not serve nested flows.
 */
export function toolStepUploadIssue(
  registry: Registry,
  tool: string,
  args: Record<string, unknown>,
  offeredOps: readonly ClientServiceOp[] | undefined,
  servesNestedFlows = true
): { kind: "nested" | "toolFile"; line: string; fixes: ToolFileFix[] } | undefined {
  if (tool === "flow-execute") {
    if (
      servesNestedFlows &&
      offeredOps?.includes("resolve-file") &&
      nestedFlowTarget(args)?.kind === "name"
    ) {
      return undefined;
    }
    return { kind: "nested", line: `tool: flow-execute${nestedFlowRef(args)}`, fixes: [] };
  }
  const refused = toolStepFilePaths(registry, tool, args).filter(
    (file) => !servedToolInput(file, offeredOps)
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

/** The sentence that tells a caller this tool-server would serve `items` for a newer client. */
export function uploadUpdateHint(items: readonly string[]): string {
  return items.length > 0
    ? ` This tool-server serves ${items.join(", and ")}. Update the argent CLI or MCP adapter on the client.`
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
 * are on the client: each file argument is read from the client and written to
 * a temp file on this host by the resolver of an HTTP call, so the tool gets
 * the same paths and the same `ctx.fileInputs` as for a direct call. A file
 * the client does not have fails the step: a server file at the same path is
 * never used in its place. A `flow-execute` gets the flow it names by `name`
 * from the client instead ({@link prepareNestedFlow}). In host mode the args
 * pass through unchanged. An input whose `unwrapWhenSet` param is set stays
 * the client path, unread, as an HTTP call unwraps it: the tool's own
 * validation diagnoses the second source.
 */
export async function prepareToolStepInputs(
  registry: Registry,
  project: ProjectAccess,
  toolId: string,
  args: Record<string, unknown>
): Promise<PreparedToolStep> {
  if (project.mode === "client" && toolId === "flow-execute") {
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
 * names under its `project_root` is resolved on the client, and goes to the
 * nested run as the `flow_file` upload of a linked call, so the nested run
 * reads the client copy, also when this host has a file at the same path.
 * The caller forwards the call's client services with it, so the nested run
 * resolves its own `run:` fragments and baselines on the client too. A flow the
 * client does not have, or has only under a name that differs in case, fails
 * with the error a run without a link gives. Args in any other form pass
 * through: the up-front check refuses them before they run.
 */
async function prepareNestedFlow(
  registry: Registry,
  project: ProjectAccess,
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
  return {
    args: resolved.args,
    ...(resolved.fileInputs ? { fileInputs: resolved.fileInputs } : {}),
    cleanup: resolved.cleanup,
  };
}
