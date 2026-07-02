/**
 * Client half of the INPUT-side file boundary (the OUTPUT side is
 * `artifacts.ts`'s materializer).
 *
 * Tools that read caller-local files declare them as `fileInputs` in their
 * `GET /tools` metadata: `{ target, path-template, kind }`. Before sending a
 * call, {@link prepareFileInputs} interpolates each template from the args,
 * stats the file on THIS machine, and replaces the target arg with a
 * `__argentFileInput` wrapper. The tool-server resolves the wrapper back to a
 * path on ITS filesystem — in place when co-located, or materialized from the
 * inlined base64 content when remote. Content is inlined only when the client
 * is routed to an external tool-server, so plain local sessions never pay for
 * encoding.
 *
 * {@link applyClientFileDirectives} is the reverse direction: a tool whose
 * output belongs in the agent's project (e.g. a recorded flow YAML) returns a
 * `__argentClientFile` directive, and this client writes the content to the
 * directive's path — constrained to `.argent/flows/*.yaml` so a misbehaving
 * tool-server cannot direct writes anywhere else on the client machine.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

/** Must match the tool-server's wire contract (`@argent/registry` file-inputs.ts). */
export const FILE_INPUT_MARKER = "__argentFileInput" as const;
export const CLIENT_FILE_MARKER = "__argentClientFile" as const;

export type FileInputKind = "file" | "directory" | "probe" | "tar-upload";

/** One declared file-boundary arg, as advertised by `GET /tools`. */
export interface FileInputSpec {
  target: string;
  path: string;
  kind: FileInputKind;
  optional?: boolean;
}

export interface FileInputWire {
  [FILE_INPUT_MARKER]: true;
  path: string;
  size?: number;
  mtimeMs?: number;
  content?: string;
  /** Why readable content was deliberately not inlined ("size-limit" = over MAX_CONTENT_BYTES). */
  contentOmitted?: "size-limit";
  uploadId?: string;
}

export interface ClientFileDirective {
  [CLIENT_FILE_MARKER]: true;
  path: string;
  content: string;
}

/**
 * Hard ceiling on inlined content, mirroring the server's decoded-upload
 * limit. A larger file is sent as a stat-only wrapper marked
 * `contentOmitted: "size-limit"`: it still resolves in place co-located, and
 * a remote server without the file answers with a precise "exceeds the
 * transfer limit" error instead of this client dying on a huge encode.
 */
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

const execFileAsync = promisify(execFile);

export interface PrepareFileInputsOptions {
  /**
   * Inline file bytes for `kind: "file"` wrappers. True when the client is
   * routed to an external tool-server (link / ARGENT_TOOLS_URL); false keeps
   * the wrapper path-only for the co-located fast path.
   */
  includeContent: boolean;
  /**
   * When set, `kind: "tar-upload"` inputs are tarballed and streamed to
   * `POST <url>/upload` before the tool call. Only populated when routed to a
   * remote tool-server; absent for co-located sessions (server reads in place).
   */
  uploadEndpoint?: { url: string; token: string };
}

/**
 * Interpolate a spec's `${param}` path template from string args. Returns
 * null when any referenced param is absent — the spec simply doesn't apply
 * to this call (required-param errors belong to the tool's own validation).
 */
function interpolatePath(template: string, args: Record<string, unknown>): string | null {
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

async function tarball(sourcePath: string): Promise<string> {
  const tarPath = path.join(tmpdir(), `argent-upload-${randomUUID()}.tar.gz`);
  try {
    await execFileAsync("tar", [
      "-czf",
      tarPath,
      "-C",
      path.dirname(sourcePath),
      path.basename(sourcePath),
    ]);
  } catch (err) {
    // `tar` can leave a partial archive the caller never sees — clean it up.
    await rm(tarPath, { force: true }).catch(() => {});
    throw err;
  }
  return tarPath;
}

async function uploadTar(
  tarPath: string,
  endpoint: { url: string; token: string }
): Promise<string> {
  // `duplex: "half"` is required to stream a Node Readable request body via
  // undici's fetch, but it isn't in the DOM RequestInit type yet.
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      "content-type": "application/gzip",
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    },
    body: createReadStream(tarPath) as unknown as BodyInit,
    duplex: "half",
  };
  const res = await fetch(`${endpoint.url}/upload`, init);
  if (!res.ok) {
    throw new Error(`Upload to ${endpoint.url}/upload failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { uploadId: string };
  return json.uploadId;
}

/**
 * Replace declared file-path args with boundary wrappers. Returns the args
 * untouched (same reference) when no spec applies, so callers can cheaply
 * pass everything through here.
 */
export async function prepareFileInputs(
  specs: FileInputSpec[] | undefined,
  args: unknown,
  opts: PrepareFileInputsOptions
): Promise<unknown> {
  if (!specs || specs.length === 0 || typeof args !== "object" || args === null) {
    return args;
  }
  const record = args as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;

  for (const spec of specs) {
    // A target the agent already filled in (e.g. an explicit server-side
    // flow_file override) is respected — wrapping it would second-guess the
    // caller with a client-side path that may not exist.
    if (spec.target in record && typeof record[spec.target] !== "string") continue;
    const filePath = interpolatePath(spec.path, record);
    if (filePath === null) continue;
    // When the target IS a source param, the interpolated path equals its
    // value; when it's a derived param (flow_file), only wrap if unset.
    if (spec.target in record && record[spec.target] !== filePath) continue;

    const wire: FileInputWire = { [FILE_INPUT_MARKER]: true, path: filePath };
    if (spec.kind === "file") {
      try {
        const st = await stat(filePath);
        if (st.isFile()) {
          wire.size = st.size;
          wire.mtimeMs = st.mtimeMs;
          if (opts.includeContent && st.size <= MAX_CONTENT_BYTES) {
            wire.content = (await readFile(filePath)).toString("base64");
          } else if (opts.includeContent) {
            // Too big to ride in the call — say so instead of sending a bare
            // wrapper, so an absent-on-server path gets a "transfer limit"
            // error rather than misleading "file not found" guidance. The
            // stat fields stay, so a co-located copy still resolves in place.
            wire.contentOmitted = "size-limit";
          }
        }
      } catch {
        // Unreadable here — send the path-only wrapper; the server may still
        // find it on its own filesystem, and otherwise errors precisely.
      }
    }

    if (spec.kind === "tar-upload" && opts.uploadEndpoint) {
      // Only upload when the path is on this machine; otherwise fall through
      // path-only so the server can resolve a path that already exists on it.
      const st = await stat(filePath).catch(() => null);
      if (st) {
        let tarPath: string | null = null;
        try {
          // Progress on stderr (stdout is the MCP protocol channel) so a slow
          // upload isn't a silent stall.
          console.error(`Uploading ${path.basename(filePath)} to the remote tool-server...`);
          tarPath = await tarball(filePath);
          wire.uploadId = await uploadTar(tarPath, opts.uploadEndpoint);
        } finally {
          if (tarPath) await rm(tarPath, { force: true }).catch(() => {});
        }
      }
    }

    out = out ?? { ...record };
    out[spec.target] = wire;
  }

  return out ?? args;
}

// ── Client-write directives ──────────────────────────────────────────

export interface AppliedClientFiles {
  /** The result with every directive replaced by the written path (or null). */
  result: unknown;
  /** Paths actually written on this machine. */
  written: string[];
}

/**
 * Trust boundary: the directive path is authored by the tool-server. Today
 * the only producer is flow recording, so writes are constrained to flow
 * files — an absolute path whose final segments are `.argent/flows/<name>.yaml`
 * with a conservative name charset and no `..` anywhere. Widen deliberately
 * (and equally conservatively) if another tool ever needs this channel.
 */
function isAllowedClientFilePath(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const segments = p.split(/[\\/]+/);
  if (segments.includes("..")) return false;
  const file = segments[segments.length - 1] ?? "";
  if (!/^[A-Za-z0-9_-]+\.yaml$/.test(file)) return false;
  return segments[segments.length - 3] === ".argent" && segments[segments.length - 2] === "flows";
}

function isClientFileDirective(value: unknown): value is ClientFileDirective {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[CLIENT_FILE_MARKER] === true &&
    typeof (value as ClientFileDirective).path === "string" &&
    typeof (value as ClientFileDirective).content === "string"
  );
}

/**
 * Deep-walk a tool result, writing every client-file directive to disk and
 * rewriting it to the written path. A directive that fails validation or the
 * write resolves to null, mirroring how the artifact materializer signals a
 * missing file. Results without directives pass through untouched.
 */
export async function applyClientFileDirectives(result: unknown): Promise<AppliedClientFiles> {
  const written: string[] = [];

  async function walk(value: unknown): Promise<unknown> {
    if (isClientFileDirective(value)) {
      if (!isAllowedClientFilePath(value.path)) return null;
      try {
        await mkdir(path.dirname(value.path), { recursive: true });
        await writeFile(value.path, value.content, "utf8");
        written.push(value.path);
        return value.path;
      } catch {
        return null;
      }
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map(walk));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = await walk(v);
      }
      return out;
    }
    return value;
  }

  const rewritten = await walk(result);
  return { result: rewritten, written };
}
