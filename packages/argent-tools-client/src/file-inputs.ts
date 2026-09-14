/**
 * Client half of the INPUT-side file boundary (`artifacts.ts` is the OUTPUT side).
 *
 * {@link prepareFileInputs} interpolates each `fileInputs` spec advertised by
 * `GET /tools`, stats the file on THIS machine, and replaces the target arg
 * with a `__argentFileInput` wrapper. The tool-server resolves it against ITS
 * filesystem — in place when co-located, else from the inlined base64, which
 * is sent only for remote tool-servers so local sessions skip the encoding.
 *
 * {@link applyClientFileDirectives} is the reverse: a `__argentClientFile`
 * directive (e.g. a recorded flow YAML) is written here, constrained to
 * `.argent/flows/*.yaml` so a misbehaving tool-server cannot write elsewhere.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createTarGzFile } from "@argent/archive";
import { FLOW_FILE_NAME_PATTERN } from "@argent/registry";

/** Must match the wire contract in `@argent/registry`'s file-inputs.ts. */
export const FILE_INPUT_MARKER = "__argentFileInput" as const;
export const CLIENT_FILE_MARKER = "__argentClientFile" as const;

export type FileInputKind = "file" | "directory" | "probe" | "tar-upload";

/** One declared file-boundary arg, as advertised by `GET /tools`. */
export interface FileInputSpec {
  target: string;
  path: string;
  kind: FileInputKind;
  optional?: boolean;
  /**
   * Skip this spec when the named param is set — it is an alternate source
   * that supersedes this template, so `target` must not be derived alongside
   * it (the tool's own validation diagnoses dual-source calls).
   */
  skipWhenSet?: string;
}

export interface FileInputWire {
  [FILE_INPUT_MARKER]: true;
  path: string;
  size?: number;
  mtimeMs?: number;
  content?: string;
  /** Readable content deliberately not inlined; "size-limit" = over MAX_CONTENT_BYTES. */
  contentOmitted?: "size-limit";
  uploadId?: string;
  /** SHA-256 hex digest of the streamed tarball; the server verifies it before extracting. */
  contentHash?: string;
}

export interface ClientFileDirective {
  [CLIENT_FILE_MARKER]: true;
  path: string;
  content: string;
}

/**
 * Mirrors the server's decoded-upload limit. A larger file is sent as a
 * stat-only wrapper marked `contentOmitted: "size-limit"`: it still resolves
 * in place co-located, and a remote server without the file reports the
 * transfer limit instead of this client dying on a huge encode.
 */
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;

export interface PrepareFileInputsOptions {
  /**
   * Inline file bytes for `kind: "file"` wrappers. True when routed to an
   * external tool-server (`argent link` / ARGENT_TOOLS_URL); false keeps the
   * wrapper path-only for the co-located fast path.
   */
  includeContent: boolean;
  /**
   * Set only when routed to a remote tool-server: `kind: "tar-upload"` inputs
   * are tarballed and streamed to `POST <url>/upload` before the tool call.
   * Absent for co-located sessions (the server reads the path in place).
   */
  uploadEndpoint?: { url: string; token: string };
}

/**
 * Interpolate a spec's `${param}` path template from string args. Null when a
 * referenced param is absent — the spec doesn't apply to this call
 * (required-param errors belong to the tool's own validation).
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
  await createTarGzFile(sourcePath, tarPath);
  return tarPath;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function uploadTar(
  tarPath: string,
  endpoint: { url: string; token: string }
): Promise<string> {
  // `duplex: "half"` is required to stream a Node Readable request body via
  // undici's fetch, but it isn't in the DOM RequestInit type.
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
 * Replace declared file-path args with boundary wrappers. Returns the same
 * args reference when no spec applies, so callers can pass everything through.
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
    // Deriving this target too would have the boundary vouch for a file the
    // call is not using, letting its existence preempt the tool's dual-source
    // validation. Any provided value counts, matching the `=== undefined`
    // presence checks that validation uses, so a degenerate value ("") is
    // still diagnosed by the tool, not by the boundary.
    if (spec.skipWhenSet && record[spec.skipWhenSet] !== undefined) continue;
    if (spec.target in record && typeof record[spec.target] !== "string") continue;
    const filePath = interpolatePath(spec.path, record);
    if (filePath === null) continue;
    // When the target IS a source param the interpolated path equals its
    // value; a derived target (flow_file) is wrapped only when unset.
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
            // Say so instead of sending a bare wrapper, so an absent-on-server
            // path errors with the transfer limit rather than misleading "file
            // not found" guidance. Stat fields stay for in-place resolution.
            wire.contentOmitted = "size-limit";
          }
        }
      } catch {
        // Unreadable here — the path-only wrapper still resolves if the
        // server has the file, and errors precisely otherwise.
      }
    }

    if (spec.kind === "tar-upload") {
      const st = await stat(filePath).catch(() => null);
      if (st) {
        wire.size = st.size;
        wire.mtimeMs = st.mtimeMs;
      }

      if (opts.uploadEndpoint && st) {
        let tarPath: string | null = null;
        try {
          // stderr, not stdout (MCP owns it), so a slow upload isn't silent.
          process.stderr.write(
            `Uploading ${path.basename(filePath)} to the remote tool-server...\n`
          );
          tarPath = await tarball(filePath);
          wire.contentHash = await sha256File(tarPath);
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

export interface AppliedClientFiles {
  /** The result with every directive replaced by the written path (or null). */
  result: unknown;
  /** Paths actually written on this machine. */
  written: string[];
}

/**
 * Trust boundary: the directive path is authored by the tool-server. Flow
 * recording is the only producer today, so writes are confined to an absolute
 * path ending `.argent/flows/<name>.yaml`, with no `..` anywhere. Widen
 * deliberately (and equally conservatively) if another tool needs this channel.
 */
function isAllowedClientFilePath(p: string): boolean {
  if (!path.isAbsolute(p)) return false;
  const segments = p.split(/[\\/]+/);
  if (segments.includes("..")) return false;
  const file = segments[segments.length - 1] ?? "";
  if (!FLOW_FILE_NAME_PATTERN.test(file)) return false;
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
 * missing file.
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
