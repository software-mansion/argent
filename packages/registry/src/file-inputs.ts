/**
 * File-input wire contract — the INPUT-side counterpart of {@link ArtifactHandle}.
 *
 * Artifacts move files the tool-server *produced* out to the client; this
 * module's types move files the client *owns* (saved screenshots, flow YAMLs)
 * in to the tool-server. A tool that reads a caller-supplied path declares it
 * in {@link ToolDefinition.fileInputs}; the declaration is surfaced through
 * `GET /tools`, so the client knows — without tool-specific logic — which args
 * name files on *its* filesystem.
 *
 * Before sending a call, the client replaces each declared arg with a
 * {@link FileInputWire} wrapper carrying the path, its stat, and (only when the
 * client is routed to a remote tool-server) the base64 file content. The
 * tool-server resolves the wrapper back to a server-readable path *before* zod
 * validation: when the path on its own disk matches the recorded stat it is
 * used in place (co-located ⇒ zero copies, exactly mirroring the artifact
 * gate), otherwise the inlined content is materialized to a temp file. Tools
 * therefore always execute against a plain local path and stay
 * location-agnostic.
 *
 * {@link ClientFileDirective} is the reverse of an upload: a tool that needs a
 * file to land in the *client's* project (e.g. a recorded flow YAML) returns
 * the content plus the client-side destination path, and the client writes it.
 */

/** Discriminant key identifying a client-file wrapper inside tool args. */
export const FILE_INPUT_MARKER = "__argentFileInput" as const;

/** What the client sends in place of a declared file-path arg. */
export interface FileInputWire {
  [FILE_INPUT_MARKER]: true;
  /**
   * Absolute path on the CLIENT machine. Also probed on the tool-server's own
   * filesystem — a hit (existence for directories, size/mtime match for files)
   * means client and server are co-located (or share a checkout) and the path
   * is used in place with no copy.
   */
  path: string;
  /** stat of `path` on the client, for the server-side co-location probe. */
  size?: number;
  mtimeMs?: number;
  /**
   * Base64 file bytes. The client inlines them only when it is routed to an
   * external tool-server (`argent link` / ARGENT_TOOLS_URL), so unlinked local
   * calls never pay the encoding cost.
   */
  content?: string;
  /**
   * Present when the client had readable content but deliberately did not
   * inline it. Lets the server explain *why* an absent-on-host file has no
   * bytes instead of guessing ("size-limit" = file exceeds the client's
   * inline-content cap). A string enum so future reasons extend it without
   * another field.
   */
  contentOmitted?: "size-limit";
  /**
   * Upload ID returned by `POST /upload` on the tool-server. Set by the client
   * for `kind: "tar-upload"` inputs when the tool-server is remote — the client
   * tars the file or directory and streams it to `/upload` before the tool
   * call, avoiding the base64-in-JSON body limit. Absent for co-located
   * sessions (the server reads the path in place).
   */
  uploadId?: string;
}

/**
 * How the server treats a declared file input:
 * - `"file"`    — the tool reads this file. Resolved to a server-readable path
 *                 (in place, or materialized from `content`); the call fails
 *                 with a clear error when neither is possible.
 * - `"directory"` — the tool reads a tree that cannot travel over the wire
 *                 (e.g. a project root). Must exist on the tool-server host;
 *                 otherwise the call fails with remote-mode guidance instead
 *                 of silently reading nothing.
 * - `"probe"`   — advisory only. The arg passes through unchanged; the tool
 *                 learns via `ctx.fileInputs` whether the path exists on the
 *                 server host and adapts (e.g. flow recording switches to
 *                 client-side persistence, screenshot-diff falls back to a
 *                 temp output dir).
 * - `"tar-upload"` — the tool reads a file or directory that the client owns
 *                 (e.g. an iOS `.app` bundle, an Android `.apk`, a Vega
 *                 `.vpkg`). Co-located: used in place. Remote: the client tars
 *                 the path, streams it to `POST /upload`, and sets `uploadId` on
 *                 the wire. The server extracts the archive to a temp dir and
 *                 passes the extracted path to the tool. Handles bundles too
 *                 big to travel as base64-in-JSON.
 */
export type FileInputKind = "file" | "directory" | "probe" | "tar-upload";

/**
 * Declaration of one file-boundary arg on a {@link ToolDefinition}. Shipped
 * verbatim to the client in `GET /tools`, so it must stay JSON-serializable
 * and dumb: `path` is a template over the tool's own string args
 * (`"${baselinePath}"`, `"${project_root}/.argent/flows/${name}.yaml"`).
 */
export interface FileInputSpec {
  /** Arg name the resolved wrapper lands in (must be a string param, may be one the agent never sets). */
  target: string;
  /** Client-side path template; `${param}` substitutes the tool's string args. */
  path: string;
  kind: FileInputKind;
  /**
   * Skip this spec silently when a referenced param is absent (e.g.
   * screenshot-diff's baselinePath in live-capture mode). A non-optional spec
   * with absent params is also skipped client-side — the tool's own zod
   * validation owns required-param errors.
   */
  optional?: boolean;
}

/** Per-target resolution outcome, passed to the tool via `ctx.fileInputs`. */
export interface ResolvedFileInput {
  /** The client-side path as originally sent in the wrapper. */
  clientPath: string;
  /** True when the path was usable on the tool-server's own filesystem. */
  presentOnHost: boolean;
  /** True when the value was materialized from uploaded content. */
  viaUpload: boolean;
}

/** Discriminant key identifying a client-write directive inside a tool result. */
export const CLIENT_FILE_MARKER = "__argentClientFile" as const;

/**
 * A file the CLIENT must persist: returned by tools whose output belongs in
 * the agent's project rather than on the tool-server host. The client writes
 * `content` to `path` and rewrites the directive to that path string, so the
 * rendered result reads the same as a server-side write used to.
 */
export interface ClientFileDirective {
  [CLIENT_FILE_MARKER]: true;
  /** Absolute CLIENT-side destination path (the client validates it before writing). */
  path: string;
  content: string;
}

export function isFileInputWire(value: unknown): value is FileInputWire {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[FILE_INPUT_MARKER] === true &&
    typeof (value as FileInputWire).path === "string"
  );
}

export function isClientFileDirective(value: unknown): value is ClientFileDirective {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[CLIENT_FILE_MARKER] === true &&
    typeof (value as ClientFileDirective).path === "string" &&
    typeof (value as ClientFileDirective).content === "string"
  );
}

/**
 * Interpolate a {@link FileInputSpec.path} template from string args.
 * Returns null when any referenced param is missing or not a non-empty
 * string — callers treat that as "spec does not apply to this call".
 * Shared by the client (to read the file) and kept here so both sides agree
 * on the micro-grammar: `${name}` only, no nesting, no defaults.
 */
export function interpolateFileInputPath(
  template: string,
  args: Record<string, unknown>
): string | null {
  let missing = false;
  const out = template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const v = args[name];
    if (typeof v !== "string" || v.length === 0) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}
