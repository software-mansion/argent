import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CLIENT_FILE_MARKER,
  FAILURE_CODES,
  FailureError,
  FLOW_FILE_NAME_PATTERN,
  flowMemberKey,
  resolveFlowRelativeFile,
  type ClientFileDirective,
  type OnDiskSpelling,
  type ResolvedMember,
} from "@argent/registry";

/**
 * A flow file reference resolved on the machine that has the project: where
 * the reference lands (`canonical`), how its basename is spelled in the
 * directory it was written against (`spelling`), and `read`, the file's text
 * — null when nothing is at `canonical`, which the caller reports as the
 * missing fragment it is. The read is deferred so the runner's guards (cycle,
 * depth, casing) decide before any file is opened, as they do today on the
 * host; a client's member already carries its text, so `read` is free.
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
 * looks each read up in the files the client sent with an uploaded flow (the
 * members of its file input), and keeps each baseline write for the result.
 *
 * In client mode every path is a CLIENT path: `canonical` serves the runner as
 * a key (the `run:` cycle guard) and for display, and the snapshot baselines
 * and the file arguments of `tool:` steps are the client's files, never files
 * on this host.
 */
export interface ProjectAccess {
  readonly mode: "host" | "client";
  /** Resolve a `run:` target against the directory of the file that names it, and read it. */
  resolveFlowFile(anchorDir: string, target: string): Promise<ResolvedFlowFile>;
  /** The bytes of a project file, or null when nothing is there. */
  readFile(filePath: string): Promise<Buffer | null>;
  /**
   * Write a snapshot baseline, creating its `__baselines__/<key>/` directory.
   * `replaced` says whether a file was there before.
   */
  writeBaseline(filePath: string, bytes: Buffer): Promise<{ replaced: boolean }>;
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

/** A path where no file can be: missing, or a file stands where a directory should. */
function isNothingThere(err: unknown): boolean {
  return isEnoent(err) || (err as { code?: unknown } | null)?.code === "ENOTDIR";
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
      if (!isNothingThere(err)) throw err;
      return null;
    }
  }

  async writeBaseline(filePath: string, bytes: Buffer): Promise<{ replaced: boolean }> {
    const replaced = await fs.access(filePath).then(
      () => true,
      () => false
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
    return { replaced };
  }
}

/** The decoded size cap of a baseline the client writes; mirrors the file-input cap. */
const BASELINE_CAP_BYTES = 32 * 1024 * 1024;

function clientRefusal(subject: string, reason: string, verb = "send"): FailureError {
  return new FailureError(`the client refused to ${verb} "${subject}": ${reason}`, {
    error_code: FAILURE_CODES.FLOW_FILE_INVALID,
    failure_stage: "client_member_refused",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/** The baselines each call wrote, by the files the client sent with it. */
const callOverlays = new WeakMap<object, Map<string, Buffer>>();

/**
 * The client's files, looked up by the key the runner resolves: the client
 * resolved each `run:` target of its flow before the call, with the same
 * resolution code the host implementation runs, and sent what it found, and
 * it sent the run's snapshot baselines by their client paths and the file
 * arguments of its `tool:` steps as the steps spell them. A `run:` pair the
 * client did not send, or refused to send, is refused here with the client's
 * reason.
 *
 * A baseline this call writes goes into an in-call overlay, which later reads
 * see first, and travels back to the client in the result
 * ({@link baselineDirectives}). The overlay belongs to the files of the call,
 * not to one instance: a nested `flow-execute` gets the same `members` and
 * builds its own instance over them, so a baseline one run of the call writes
 * is what a later run of the same call reads, and the outermost run returns
 * every write.
 */
export class ClientProjectAccess implements ProjectAccess {
  readonly mode = "client" as const;
  /** Baselines this call wrote, by client path. */
  private readonly overlay: Map<string, Buffer>;

  constructor(readonly members: Readonly<Record<string, ResolvedMember>>) {
    let overlay = callOverlays.get(members);
    if (overlay === undefined) {
      overlay = new Map();
      callOverlays.set(members, overlay);
    }
    this.overlay = overlay;
  }

  /** The member the runner reaches for this pair, or undefined when the client did not send one. */
  member(anchorDir: string, target: string): ResolvedMember | undefined {
    const key = flowMemberKey(anchorDir, target);
    return Object.hasOwn(this.members, key) ? this.members[key] : undefined;
  }

  async resolveFlowFile(anchorDir: string, target: string): Promise<ResolvedFlowFile> {
    const member = this.member(anchorDir, target);
    if (member?.role !== "flow" || member.state === "refused" || member.canonical === undefined) {
      throw clientRefusal(
        target,
        member?.error ?? `${target} is not a run: target of a flow this client sent`
      );
    }
    const text = member.state === "present" ? (member.text ?? "") : null;
    return {
      canonical: member.canonical,
      spelling: member.spelling ?? { state: "listed" },
      read: async () => text,
    };
  }

  /**
   * A file the client sent by its path: a baseline, or a file argument of a
   * `tool:` step. The client sends one path once, so a tool file at a
   * baseline's path stands for that baseline too.
   */
  private file(filePath: string): ResolvedMember | undefined {
    const member = Object.hasOwn(this.members, filePath) ? this.members[filePath] : undefined;
    return member?.role === "baseline" || member?.role === "tool" ? member : undefined;
  }

  /**
   * A baseline of this run or a file argument of a `tool:` step: the bytes
   * this call wrote there, else the file the client sent, else null, the "no
   * baseline" outcome: a compare run gets every baseline of its snapshots the
   * client has, and every file a `tool:` step names.
   */
  async readFile(filePath: string): Promise<Buffer | null> {
    const written = this.overlay.get(filePath);
    if (written !== undefined) return written;
    const member = this.file(filePath);
    if (member === undefined || member.state === "missing") return null;
    if (member.state === "present" && member.hostPath !== undefined) {
      return fs.readFile(member.hostPath);
    }
    throw clientRefusal(
      filePath,
      member.error ?? "the client sent only its name, for a run that updates baselines"
    );
  }

  /**
   * Keep a new baseline for the result and for later reads in this call.
   * `replaced` says whether one was there before: written earlier in this
   * call, or on the client.
   */
  async writeBaseline(filePath: string, bytes: Buffer): Promise<{ replaced: boolean }> {
    if (bytes.length > BASELINE_CAP_BYTES) {
      throw new FailureError(
        `the baseline for "${filePath}" is larger than the 32 MiB cap on a file the client ` +
          `writes, so this tool-server did not keep it`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "client_content_cap",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const member = this.file(filePath);
    if (member?.state === "refused") {
      throw clientRefusal(filePath, member.error ?? "refused", "write");
    }
    const replaced =
      this.overlay.has(filePath) || (member !== undefined && member.state !== "missing");
    this.overlay.set(filePath, bytes);
    return { replaced };
  }

  /** The baselines this call wrote, last bytes per path, as directives for the result. */
  baselineDirectives(): ClientFileDirective[] {
    return [...this.overlay].map(([filePath, bytes]) => ({
      [CLIENT_FILE_MARKER]: true,
      path: filePath,
      content: bytes.toString("base64"),
      encoding: "base64",
    }));
  }
}
