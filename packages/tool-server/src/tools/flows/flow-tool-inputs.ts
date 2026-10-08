import * as path from "node:path";
import {
  FILE_INPUT_MARKER,
  hasToolFileExtension,
  interpolateFileInputPath,
  type ClientServiceOp,
  type FileInputSpec,
  type FileInputWire,
  type Registry,
  type ResolvedFileInput,
} from "@argent/registry";
import { FileInputError, resolveFileInputs } from "../../file-inputs";
import type { ProjectAccess } from "./project-access";

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
 * never used in its place. In host mode, and for `flow-execute`, the args pass
 * through unchanged. An input whose `unwrapWhenSet` param is set stays the
 * client path, unread, as an HTTP call unwraps it: the tool's own validation
 * diagnoses the second source.
 */
export async function prepareToolStepInputs(
  registry: Registry,
  project: ProjectAccess,
  toolId: string,
  args: Record<string, unknown>
): Promise<PreparedToolStep> {
  const files =
    project.mode === "client" && toolId !== "flow-execute"
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
