import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CLIENT_FILE_OP_TIMEOUT_MS,
  FAILURE_CODES,
  FailureError,
  FLOW_FILE_NAME_PATTERN,
  resolveFlowRelativeFile,
  type OnDiskSpelling,
  type ReadFileArgs,
  type ResolveFileArgs,
  type ToolContext,
  type WriteFileArgs,
} from "@argent/registry";

/**
 * A flow file reference resolved on the machine that has the project: where
 * the reference lands (`canonical`), how its basename is spelled in the
 * directory it was written against (`spelling`), and `read`, the file's text
 * — null when nothing is at `canonical`, which the caller reports as the
 * missing fragment it is. The read is deferred so the runner's guards (cycle,
 * depth, casing) decide before any file is opened, as they do today on the
 * host; over the channel the text arrived with the answer, so `read` is free.
 */
export interface ResolvedFlowFile {
  canonical: string;
  spelling: OnDiskSpelling;
  read(): Promise<string | null>;
}

/**
 * The one seam every project read and write in the flow runner goes through.
 * The runner stays on the tool-server; the project is wherever the caller's
 * files are. {@link HostProjectAccess} uses this host's disk — a co-located
 * caller, or a flow the tool-server found in place. {@link ClientProjectAccess}
 * sends each read and write to the caller over the client-services channel,
 * for a flow that arrived as an upload from a client that offered to serve its
 * files.
 *
 * In client mode every path is a CLIENT path: `canonical` serves the runner as
 * a key (the `run:` cycle guard) and for display, and the snapshot baselines
 * are read and written there through the client, never on this host.
 */
export interface ProjectAccess {
  readonly mode: "host" | "client";
  /** Resolve a `run:` target against the directory of the file that names it, and read it. */
  resolveFlowFile(anchorDir: string, target: string): Promise<ResolvedFlowFile>;
  /** The bytes of a project file, or null when nothing is there. */
  readFile(filePath: string): Promise<Buffer | null>;
  /** Write a snapshot baseline, creating its `__baselines__/<key>/` directory. */
  writeBaseline(filePath: string, bytes: Buffer): Promise<void>;
}

/**
 * Where a snapshot baseline lives on the client: beside the real file of the
 * root flow, as on one computer. POSIX joins, because it is a client path and
 * a link serves POSIX clients only.
 */
export function clientBaselinePath(clientFlowPath: string, key: string, file: string): string {
  return path.posix.join(path.posix.dirname(clientFlowPath), "__baselines__", key, file);
}

function isEnoent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

export class HostProjectAccess implements ProjectAccess {
  readonly mode = "host" as const;

  async resolveFlowFile(anchorDir: string, target: string): Promise<ResolvedFlowFile> {
    const { canonical, spelling } = await resolveFlowRelativeFile(
      anchorDir,
      target,
      FLOW_FILE_NAME_PATTERN
    );
    return {
      canonical,
      spelling,
      read: async () => {
        try {
          return await fs.readFile(canonical, "utf8");
        } catch (err) {
          // Only a missing file is the "no such fragment" answer; a directory
          // or an unreadable file keeps its own error so the step reason
          // names it.
          if (!isEnoent(err)) throw err;
          return null;
        }
      },
    };
  }

  async readFile(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      return null;
    }
  }

  async writeBaseline(filePath: string, bytes: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
  }
}

type ClientServices = NonNullable<ToolContext["clientServices"]>;

function invalidAnswer(op: string, subject: string): FailureError {
  return new FailureError(
    `the client answered the ${op} request for "${subject}" with an invalid payload`,
    {
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "client_request_refused",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

function isSpelling(value: unknown): value is OnDiskSpelling {
  if (typeof value !== "object" || value === null) return false;
  const { state, actual, addressable } = value as Record<string, unknown>;
  if (state === "listed" || state === "absent") return true;
  return state === "case_folded" && typeof actual === "string" && typeof addressable === "boolean";
}

/**
 * The client-services implementation: each read or write is one request line
 * on the call's stream, answered by the client from its own disk through the
 * same resolution code the host implementation runs. The client decides what
 * it serves and accepts (its roots, the file kinds, the size cap, where a
 * baseline may land); this side only checks that an answer has the shape the
 * op promises.
 */
export class ClientProjectAccess implements ProjectAccess {
  readonly mode = "client" as const;

  constructor(private readonly services: ClientServices) {}

  async resolveFlowFile(anchorDir: string, target: string): Promise<ResolvedFlowFile> {
    const answer = await this.services.request(
      "resolve-file",
      { anchorDir, target, kind: "flow" } satisfies ResolveFileArgs,
      CLIENT_FILE_OP_TIMEOUT_MS
    );
    const { canonical, spelling, exists, content } = answer;
    if (typeof canonical !== "string" || !isSpelling(spelling) || typeof exists !== "boolean") {
      throw invalidAnswer("resolve-file", target);
    }
    if (!exists) return { canonical, spelling, read: async () => null };
    if (typeof content !== "string") throw invalidAnswer("resolve-file", target);
    const text = Buffer.from(content, "base64").toString("utf8");
    return { canonical, spelling, read: async () => text };
  }

  async readFile(filePath: string): Promise<Buffer | null> {
    const answer = await this.services.request(
      "read-file",
      { path: filePath } satisfies ReadFileArgs,
      CLIENT_FILE_OP_TIMEOUT_MS
    );
    const { exists, content } = answer;
    if (typeof exists !== "boolean") throw invalidAnswer("read-file", filePath);
    if (!exists) return null;
    if (typeof content !== "string") throw invalidAnswer("read-file", filePath);
    return Buffer.from(content, "base64");
  }

  async writeBaseline(filePath: string, bytes: Buffer): Promise<void> {
    const answer = await this.services.request(
      "write-file",
      { path: filePath, content: bytes.toString("base64") } satisfies WriteFileArgs,
      CLIENT_FILE_OP_TIMEOUT_MS
    );
    if (typeof answer.written !== "string") throw invalidAnswer("write-file", filePath);
  }
}
