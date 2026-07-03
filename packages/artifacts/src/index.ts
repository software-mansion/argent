/** Discriminant key identifying an artifact handle inside a tool result. */
export const ARTIFACT_MARKER = "__argentArtifact" as const;

/**
 * Semantic artifact category. MIME type tells consumers how to read the bytes;
 * kind tells them what the artifact represents.
 */
export type ArtifactKind =
  | "screenshot"
  | "screenshot-diff"
  | "screenshot-diff-context"
  | "native-profile-trace"
  | "native-profile-cpu"
  | "native-profile-hangs"
  | "native-profile-leaks"
  | "native-profile-report"
  | "react-profile-cpu"
  | "react-profile-commits"
  | "react-profile-report";

/** Wire contract: what a tool returns in place of a host path. */
export interface ArtifactHandle {
  [ARTIFACT_MARKER]: true;
  id: string;
  kind: ArtifactKind;
  filename: string;
  mimeType: string;
  size: number;
  /**
   * Absolute path of the file on the tool-server host. Present on current
   * servers so co-located clients can read the file directly; optional for
   * compatibility with older servers and remote-only handles.
   */
  hostPath?: string;
  /** mtime of {@link hostPath} (ms) at registration, for client integrity checks. */
  mtimeMs?: number;
  /**
   * Present when the artifact is a directory bundle (e.g. an Instruments
   * `.trace`). Remote downloads stream it as a gzipped tar.
   */
  archive?: "tar.gz";
}

export interface ArtifactOutputSpec {
  /** Semantic category of this declared tool output, distinct from MIME type. */
  kind: ArtifactKind;
  /** Optional human-readable explanation for tool-listing consumers. */
  description?: string;
  /** Optional MIME types this output normally produces. */
  mimeTypes?: string[];
}

export type ArtifactOutputMap = Record<string, ArtifactOutputSpec>;
