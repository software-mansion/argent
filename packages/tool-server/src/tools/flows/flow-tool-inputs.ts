import * as path from "node:path";
import {
  FILE_INPUT_MARKER,
  isClientFileArgument,
  toolStepFiles,
  type FileInputWire,
  type Registry,
  type ResolvedFileInput,
  type ToolStepFile,
} from "@argent/registry";
import { FileInputError, resolveFileInputs } from "../../file-inputs";
import type { ProjectAccess } from "./project-access";

/** The file inputs a `tool:` step's args fill in for the tool it names ({@link toolStepFiles}). */
export function toolStepFilePaths(
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
export function servedToolInput(file: ToolStepFile, withFiles: boolean): boolean {
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
 * never used in its place. In host mode, and for `flow-execute`, the args pass
 * through unchanged. An input whose `unwrapWhenSet` param is set stays the
 * client path, unread, as an HTTP call unwraps it: the tool's own validation
 * diagnoses the second source. The client skips such an input too.
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
