import * as fs from "node:fs/promises";
import {
  FAILURE_CODES,
  FailureError,
  FLOW_FILE_NAME_PATTERN,
  flowMemberKey,
  resolveFlowRelativeFile,
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
 * The one seam every project read in the flow runner goes through. The runner
 * stays on the tool-server; the project is wherever the caller's files are.
 * {@link HostProjectAccess} reads this host's disk — a co-located caller, or a
 * flow the tool-server found in place. {@link ClientProjectAccess} looks each
 * read up in the files the client sent with an uploaded flow (the members of
 * its file input).
 *
 * In client mode `canonical` is a CLIENT path: the runner uses it as a key (the
 * `run:` cycle guard) and for display, and never opens it.
 */
export interface ProjectAccess {
  readonly mode: "host" | "client";
  /** Resolve a `run:` target against the directory of the file that names it, and read it. */
  resolveFlowFile(anchorDir: string, target: string): Promise<ResolvedFlowFile>;
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
}

/**
 * The client's files, looked up by the pair the runner resolves: the client
 * resolved each `run:` target of its flow on its own disk before the call,
 * named it as the host implementation names it (`canonicalFlowPath`), and sent
 * what it found. A pair the client did not send, or refused to send, is
 * refused here with the client's reason.
 */
export class ClientProjectAccess implements ProjectAccess {
  readonly mode = "client" as const;

  constructor(private readonly members: Readonly<Record<string, ResolvedMember>>) {}

  /** The member the runner reaches for this pair, or undefined when the client did not send one. */
  member(anchorDir: string, target: string): ResolvedMember | undefined {
    const key = flowMemberKey(anchorDir, target);
    return Object.hasOwn(this.members, key) ? this.members[key] : undefined;
  }

  async resolveFlowFile(anchorDir: string, target: string): Promise<ResolvedFlowFile> {
    const member = this.member(anchorDir, target);
    if (member?.role !== "flow" || member.state === "refused") {
      const reason = member?.error ?? `${target} is not a run: target of a flow this client sent`;
      throw new FailureError(`the client refused to send "${target}": ${reason}`, {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "client_member_refused",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }
    const text = member.state === "present" ? (member.text ?? "") : null;
    return { canonical: member.canonical, spelling: member.spelling, read: async () => text };
  }
}
