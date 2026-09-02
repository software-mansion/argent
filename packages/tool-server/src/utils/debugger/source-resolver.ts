import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseStackTrace } from "stacktrace-parser";

// The project-root containment check alone still admits an .env or a
// credential-bearing .json inside the project, hence this allowlist. Stack
// frames and React fiber _debugSource only ever point at code files.
const ALLOWED_SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

function isInsideProject(absFile: string, projectRoot: string): boolean {
  // `path.resolve("")` is the tool-server's cwd, not the app's, so an empty
  // root would make everything under the tool-server read as "inside the
  // project". readSourceFragment bails first; keep the predicate total anyway.
  if (!projectRoot) return false;
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedFile = path.resolve(absFile);
  const rel = path.relative(resolvedRoot, resolvedFile);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function hasAllowedExtension(filePath: string): boolean {
  return ALLOWED_SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface SourceResolver {
  resolveDebugStack(debugStack: string): Promise<SourceLocation | null>;
  symbolicate(
    bundleUrl: string,
    line: number,
    col: number,
    methodName?: string
  ): Promise<SourceLocation | null>;
  readSourceFragment(location: SourceLocation, contextLines?: number): Promise<string | null>;
}

interface StackFrame {
  fn: string;
  file: string;
  line: number;
  col: number;
}

/**
 * Frame[0] is React internal, frame[1] is the JSX call-site in the parent.
 *
 * `stacktrace-parser` covers the V8/Hermes/JSC line shapes RN emits, including
 * `:line` with no column and locations inside a bundle URL that carries its own
 * `:port` and query string.
 */
export function parseDebugStack(stack: string): StackFrame[] {
  return parseStackTrace(stack).map((frame) => ({
    fn: frame.methodName?.trim() || "anonymous",
    file: frame.file ?? "",
    line: frame.lineNumber ?? 0,
    col: frame.column ?? 0,
  }));
}

/**
 * iOS emits `//&` where the query's `?` belongs; Android reaches Metro through a
 * device-side host alias (10.0.2.2) that only resolves on the device.
 */
export function normalizeBundleUrl(rawUrl: string, port: number): string {
  let url = rawUrl.replace(/\/\/&/, "?");

  try {
    const parsed = new URL(url);
    parsed.hostname = "localhost";
    parsed.port = port.toString();
    url = parsed.toString();
  } catch {
    // not a valid URL, return as-is
  }

  return url;
}

export function createSourceResolver(port: number, projectRoot: string): SourceResolver {
  async function symbolicateFrame(
    bundleUrl: string,
    lineNumber: number,
    column: number,
    methodName = "unknown"
  ): Promise<SourceLocation | null> {
    const file = normalizeBundleUrl(bundleUrl, port);
    try {
      const res = await fetch(`http://localhost:${port}/symbolicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stack: [{ file, lineNumber, column, methodName }],
        }),
      });
      const data = (await res.json()) as {
        stack?: Array<{
          file?: string;
          lineNumber?: number;
          column?: number;
        }>;
      };
      const frame = data.stack?.[0];
      if (!frame?.file) return null;

      // A failed symbolication echoes the bundle URL back unchanged. A
      // successful one yields a real file path, including node_modules sources
      // (expo-router / react-navigation route components) worth keeping.
      if (/^https?:\/\//.test(frame.file)) return null;

      // With no root (RN 0.72 / Vega Metro sends no X-React-Native-Project-Root)
      // `replace("" + "/", "")` would delete the first slash anywhere in the
      // path, so hand it back untouched instead.
      const relFile = projectRoot
        ? frame.file.replace(projectRoot + "/", "").replace(/^\/+/, "")
        : frame.file;

      return {
        file: relFile,
        line: frame.lineNumber ?? 0,
        column: frame.column ?? 0,
      };
    } catch {
      return null;
    }
  }

  return {
    async resolveDebugStack(debugStack: string): Promise<SourceLocation | null> {
      const frames = parseDebugStack(debugStack);
      const target = frames[1] ?? frames[0];
      if (!target?.file) return null;
      return symbolicateFrame(target.file, target.line, target.col, target.fn);
    },

    symbolicate: symbolicateFrame,

    async readSourceFragment(location: SourceLocation, contextLines = 3): Promise<string | null> {
      // Fail closed with no project root (RN 0.72 / Vega Metro reports none):
      // containment cannot be established, and the checks below would otherwise
      // lean on `fs.realpath("")` rejecting — a quirk of the promises API (the
      // sync one happily returns the tool-server's cwd).
      if (!projectRoot) return null;
      try {
        // location.file ultimately comes from a React fiber's
        // _debugSource.fileName, i.e. from attacker-controllable code inside
        // the JS runtime, so the containment and extension gates below are all
        // that stop it reading any file the tool-server's user can read.
        const absPath = path.isAbsolute(location.file)
          ? path.resolve(location.file)
          : path.resolve(projectRoot, location.file);
        // Resolve symlinks (including symlinked path components, e.g. macOS
        // /tmp -> /private/tmp) before the checks: a symlink inside projectRoot
        // can point outside it and fs.readFile would follow it. realpath throws
        // ENOENT for a missing file, which the surrounding catch turns to null.
        const realRoot = await fs.realpath(projectRoot);
        const realPath = await fs.realpath(absPath);
        if (!isInsideProject(realPath, realRoot)) return null;
        if (!hasAllowedExtension(realPath)) return null;
        const content = await fs.readFile(realPath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, location.line - 1 - contextLines);
        const end = Math.min(lines.length, location.line + contextLines);
        return lines
          .slice(start, end)
          .map((l, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === location.line ? ">" : " ";
            return `${marker} ${lineNum.toString().padStart(4)} | ${l}`;
          })
          .join("\n");
      } catch {
        return null;
      }
    },
  };
}
