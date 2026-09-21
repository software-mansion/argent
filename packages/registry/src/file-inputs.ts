export const FILE_INPUT_MARKER = "__argentFileInput" as const;

export interface FileInputWire {
  [FILE_INPUT_MARKER]: true;
  path: string;
  size?: number;
  mtimeMs?: number;
  content?: string;
  contentOmitted?: "size-limit";
  uploadId?: string;
  contentHash?: string;
}

export type FileInputKind = "file" | "directory" | "probe" | "tar-upload";

/**
 * Declaration of one file-boundary arg on a {@link ToolDefinition}. Shipped
 * verbatim to the client in `GET /tools`, so it must stay JSON-serializable
 * and dumb: `path` is a template over the tool's own string args
 * (`"${baselinePath}"`, `"${project_root}/.argent/flows/${name}.yaml"`).
 */
export interface FileInputSpec {
  target: string;
  path: string;
  kind: FileInputKind;
  optional?: boolean;
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

export interface ResolvedFileInput {
  clientPath: string;
  presentOnHost: boolean;
  viaUpload: boolean;
  statVerified?: boolean;
}

const FLOW_NAME_CHARSET = "[A-Za-z0-9_-]+";

export const FLOW_NAME_PATTERN = new RegExp(`^${FLOW_NAME_CHARSET}$`);

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

export const CLIENT_FILE_MARKER = "__argentClientFile" as const;

export interface ClientFileDirective {
  [CLIENT_FILE_MARKER]: true;
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
