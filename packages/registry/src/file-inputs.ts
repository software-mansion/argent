/**
 * File-input wire contract — the INPUT-side counterpart of {@link ArtifactHandle}.
 *
 * Artifacts move files the tool-server *produced* out to the client; this
 * module's types move files the client *owns* (saved screenshots, flow YAMLs)
 * in. A tool declares its caller-supplied paths in
 * {@link ToolDefinition.fileInputs}; the declaration is surfaced through
 * `GET /tools`, so the client knows — without tool-specific logic — which args
 * name files on *its* filesystem.
 *
 * The client replaces each declared arg with a {@link FileInputWire} carrying
 * the path, its stat, and (only when routed to a remote tool-server) the
 * base64 content. The tool-server resolves it back to a server-readable path
 * *before* zod validation: used in place when the path on its own disk matches
 * the recorded stat (co-located ⇒ zero copies, mirroring the artifact gate),
 * otherwise materialized from the inlined content. Tools therefore always
 * execute against a plain local path.
 *
 * {@link ClientFileDirective} is the reverse: a tool whose output belongs in
 * the *client's* project (e.g. a recorded flow YAML) returns the content plus
 * the client-side destination path, and the client writes it.
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
   * Base64 file bytes, inlined only when the client is routed to an external
   * tool-server (`argent link` / ARGENT_TOOLS_URL), so unlinked local calls
   * never pay the encoding cost.
   */
  content?: string;
  /**
   * The client had readable content but deliberately did not inline it, so the
   * server can explain *why* an absent-on-host file has no bytes instead of
   * guessing ("size-limit" = over the client's inline-content cap).
   */
  contentOmitted?: "size-limit";
  /**
   * Upload ID returned by `POST /upload`. Set together with
   * {@link contentHash} for remote `kind: "tar-upload"` inputs — the client
   * tars the file or directory and streams it ahead of the call, avoiding the
   * base64-in-JSON body limit. Absent for co-located sessions (the server
   * reads the path in place).
   */
  uploadId?: string;
  /**
   * SHA-256 hex digest of the streamed tarball bytes. Required whenever
   * {@link uploadId} is set; the server recomputes the digest while receiving
   * `POST /upload` and rejects a mismatch before extraction.
   */
  contentHash?: string;
}

/**
 * How the server treats a declared file input:
 * - `"file"`    — resolved to a server-readable path (in place, or
 *                 materialized from `content`); the call fails with a clear
 *                 error when neither is possible.
 * - `"directory"` — a tree that cannot travel over the wire (e.g. a project
 *                 root). Must exist on the tool-server host; otherwise the
 *                 call fails with remote-mode guidance instead of silently
 *                 reading nothing.
 * - `"probe"`   — advisory only. The arg passes through unchanged; the tool
 *                 learns via `ctx.fileInputs` whether the path exists on the
 *                 server host and adapts (e.g. flow recording switches to
 *                 client-side persistence).
 * - `"tar-upload"` — a file or directory the client owns (e.g. an iOS `.app`
 *                 bundle, an Android `.apk`, a Vega `.vpkg`). Co-located: used
 *                 in place when path + stat match. Remote: the client tars the
 *                 path, streams it to `POST /upload`, and the server always
 *                 extracts from the upload (even if the path also exists
 *                 locally) into a hash-prefixed temp dir.
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
  optional?: boolean;
  /**
   * Client-DERIVED targets only: skip this spec whenever the named param is
   * set — it is an alternate source that supersedes this template (e.g.
   * flow-execute's flow_file spec is skipped when flow_path is set). The
   * client then does not derive/wrap `target`, and the server drops a derived
   * wrapper an older client still sent, so a dual-source misuse is diagnosed
   * by the tool's own validation instead of by this spec's file resolution.
   * A caller-authored target needs {@link unwrapWhenSet}.
   */
  skipWhenSet?: string;
  /**
   * Server-side: unwrap this spec's wrapper back to its client path string —
   * neither resolved nor dropped — whenever the named param is set. The
   * complement of {@link skipWhenSet} for a CALLER-authored target with an
   * alternate source param (e.g. flow-execute's flow_path vs name): both on
   * the wire is a dual-source misuse the tool's own exactly-one validation
   * must diagnose, so the boundary must not resolve the wrapper (the error
   * would hinge on whether an unused file exists) and must not drop it (which
   * would erase the caller's mistake and silently run the other source).
   * Unwrapping hands zod both params as plain strings. Clients ignore this
   * field.
   */
  unwrapWhenSet?: string;
}

/** Per-target resolution outcome, passed to the tool via `ctx.fileInputs`. */
export interface ResolvedFileInput {
  /** The client-side path as originally sent in the wrapper. */
  clientPath: string;
  /** True when the path was usable on the tool-server's own filesystem. */
  presentOnHost: boolean;
  /** True when the value was materialized from uploaded content. */
  viaUpload: boolean;
  /**
   * True only when the wire carried BOTH client stat fields and the host file
   * matched both — the strong same-file evidence a containment gate can
   * require; absent for directory/probe kinds and for stat-less wrappers
   * (which `presentOnHost` deliberately still accepts).
   */
  statVerified?: boolean;
}

/** Path-safe flow-name charset: no separators, no "..", no spaces. */
const FLOW_NAME_CHARSET = "[A-Za-z0-9_-]+";

/**
 * The one authoritative flow-name pattern — shared by the tool-server's flow
 * tools and the CLI so the contract cannot drift between packages.
 */
export const FLOW_NAME_PATTERN = new RegExp(`^${FLOW_NAME_CHARSET}$`);

/** `<flow-name>.yaml` filename check, derived from the same charset. */
export const FLOW_FILE_NAME_PATTERN = new RegExp(`^${FLOW_NAME_CHARSET}\\.yaml$`);

/**
 * `<name>.mjs` / `<name>.sh` filename check for a flow `script:` target. Shares
 * the charset of the flow-name patterns above, so a name legal in a `run:`
 * target stays legal in a `script:` path.
 *
 * The extension is the only thing that says which interpreter runs the file, so
 * one spelling per language and no synonyms: `.mjs` pins the module type against
 * a project's `package.json` `type` field, and `.sh` names bash — `.js` and
 * `.bash` are refused so a reader never has to ask which of two spellings a
 * project uses. `scriptInterpreter` in the tool-server's `flow-utils.ts` maps
 * each accepted extension to its interpreter; widening one without the other
 * fails a test.
 */
export const SCRIPT_FILE_NAME_PATTERN = new RegExp(`^${FLOW_NAME_CHARSET}\\.(mjs|sh)$`);

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
 * Grammar: `${name}` only, no nesting, no defaults.
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
