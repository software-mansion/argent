import { promises as fs } from "fs";
import { join } from "path";

// Tree-sitter requires native bindings loaded via require (CJS context)

const _require = require;

export interface TreeSitterNode {
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  type: string;
  children: TreeSitterNode[];
  childCount: number;
  namedChildren: TreeSitterNode[];
  parent: TreeSitterNode | null;
}

interface ParserInstance {
  setLanguage(lang: unknown): void;
  parse(src: string): { rootNode: TreeSitterNode };
}

type ParserCtor = new () => ParserInstance;

export interface ComponentMatch {
  file: string;
  line: number; // 1-based
  col: number; // 0-based
}

export interface ComponentIndexEntry {
  file: string;
  line: number; // 1-based
  col: number; // 0-based
  isMemoized: boolean;
  hasUseCallback: boolean;
  hasUseMemo: boolean;
  // Other components found under the same name elsewhere in the project — most
  // commonly platform variants (List.tsx vs List.web.tsx). The lookup key is
  // just the name, so without surfacing these a caller asking for "List" would
  // be silently handed whichever file happened to be walked first. The fields
  // above hold the primary match (chosen deterministically — see pickPrimary);
  // these are the remaining candidates, exposed so callers can tell an
  // ambiguous name apart instead of trusting a single arbitrary location.
  otherMatches?: ComponentMatch[];
}

export type ComponentIndex = Map<string, ComponentIndexEntry>;

export interface AstIndexResult {
  index: ComponentIndex;
  treeSitterAvailable: boolean;
  indexedFiles: number;
}

// ---------------------------------------------------------------------------
// Load tree-sitter lazily (graceful fallback if not compiled)
// ---------------------------------------------------------------------------

let _ParserClass: ParserCtor | null = null;
let _tsLanguage: unknown = null;
let _tsxLanguage: unknown = null;
let _treeSitterLoaded = false;

function loadTreeSitter(): {
  ParserClass: ParserCtor;
  ts: unknown;
  tsx: unknown;
} | null {
  if (_treeSitterLoaded) {
    if (!_ParserClass || !_tsLanguage || !_tsxLanguage) return null;
    return { ParserClass: _ParserClass, ts: _tsLanguage, tsx: _tsxLanguage };
  }
  _treeSitterLoaded = true;

  try {
    const TSModule = _require("tree-sitter");

    _ParserClass = (TSModule.default ?? TSModule) as ParserCtor;

    const TSLang = _require("tree-sitter-typescript");

    _tsLanguage = TSLang.typescript ?? TSLang.default?.typescript;

    _tsxLanguage = TSLang.tsx ?? TSLang.default?.tsx;
  } catch {
    // tree-sitter not available
    return null;
  }

  if (!_ParserClass || !_tsLanguage || !_tsxLanguage) return null;
  return { ParserClass: _ParserClass, ts: _tsLanguage, tsx: _tsxLanguage };
}

// ---------------------------------------------------------------------------

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "android", "ios", "dist", "build", ".expo"]);

async function findSourceFiles(dir: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name)) {
          await walk(join(current, entry.name));
        }
      } else if (entry.isFile()) {
        const name = entry.name;
        if (
          name.endsWith(".ts") ||
          name.endsWith(".tsx") ||
          name.endsWith(".js") ||
          name.endsWith(".jsx")
        ) {
          result.push(join(current, name));
        }
      }
    }
  }

  await walk(dir);
  return result;
}

function isCapitalized(name: string): boolean {
  if (name.length === 0) return false;
  const first = name[0];
  return first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();
}

function nodeContainsCall(node: TreeSitterNode, callName: string): boolean {
  if (node.type === "call_expression") {
    const funcChild = node.children[0];
    if (funcChild) {
      if (funcChild.text === callName) return true;
      if (funcChild.type === "member_expression" && funcChild.children[2]?.text === callName) {
        return true;
      }
    }
  }
  for (const child of node.children) {
    if (nodeContainsCall(child, callName)) return true;
  }
  return false;
}

/**
 * Detect a React component wrapper call: memo(...) / forwardRef(...) /
 * React.memo(...) / React.forwardRef(...) (also nested, e.g. memo(forwardRef(...)),
 * since the outer callee is what we match). Components declared as
 * `const X = memo(...)` / `const X = forwardRef(...)` have a call_expression
 * value node, so without recognising these they would be missed entirely --
 * and profiler-flagged components are disproportionately memo-wrapped.
 */
function reactWrapperCall(node: TreeSitterNode | undefined): {
  isWrapper: boolean;
  isMemo: boolean;
} {
  if (!node || node.type !== "call_expression") return { isWrapper: false, isMemo: false };
  const callee = node.children[0];
  let name: string | undefined;
  if (callee?.type === "identifier") name = callee.text;
  else if (callee?.type === "member_expression")
    name = callee.children[callee.children.length - 1]?.text;
  if (name === "memo") return { isWrapper: true, isMemo: true };
  if (name === "forwardRef") return { isWrapper: true, isMemo: false };
  return { isWrapper: false, isMemo: false };
}

function isWrappedInMemo(source: string, componentName: string): boolean {
  const memoPattern = /\b(React\.memo|memo)\s*\(\s*(\w+)/g;
  let match;
  while ((match = memoPattern.exec(source)) !== null) {
    if (match[2] === componentName) return true;
  }
  return false;
}

// React Native / Metro resolves platform-specific extensions (.ios / .android /
// .native, plus web's .web) over the base file only when bundling for that
// platform; the base file (no platform segment) is the general default. So when
// the same component name exists in several files, prefer the base as primary.
const PLATFORM_SUFFIX = /\.(web|ios|android|native)\.[jt]sx?$/;

function isPlatformVariant(file: string): boolean {
  return PLATFORM_SUFFIX.test(file);
}

/**
 * Order same-named component candidates deterministically and split into the
 * primary match plus the rest. Previously the first file the directory walk
 * happened to reach won, so "which List survives" was effectively arbitrary and
 * a lookup could return the wrong platform variant's source. Base files sort
 * ahead of platform variants; ties break on path, then line, then column — all
 * walk-order independent.
 */
function pickPrimary(entries: ComponentIndexEntry[]): {
  primary: ComponentIndexEntry;
  others: ComponentMatch[];
} {
  const sorted = entries.slice().sort((a, b) => {
    const variantDelta = Number(isPlatformVariant(a.file)) - Number(isPlatformVariant(b.file));
    if (variantDelta !== 0) return variantDelta;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
  });
  const [primary, ...rest] = sorted;
  return {
    primary,
    others: rest.map((e) => ({ file: e.file, line: e.line, col: e.col })),
  };
}

/**
 * Build an in-memory index of all React components in the project.
 * Returns the index plus diagnostics (treeSitterAvailable, indexedFiles).
 * Returns empty index with treeSitterAvailable=false if tree-sitter is not available.
 */
export async function buildAstIndexWithDiagnostics(projectRoot: string): Promise<AstIndexResult> {
  const index: ComponentIndex = new Map();

  const ts = loadTreeSitter();
  if (!ts) return { index, treeSitterAvailable: false, indexedFiles: 0 };

  const { ParserClass, ts: tsLang, tsx: tsxLang } = ts;

  const files = await findSourceFiles(projectRoot);

  // Collect every match per name first, then resolve a deterministic primary
  // once all files are walked — picking eagerly during the walk would re-tie
  // the result to directory-walk order.
  const candidates = new Map<string, ComponentIndexEntry[]>();
  function addCandidate(name: string, entry: ComponentIndexEntry): void {
    const existing = candidates.get(name);
    if (existing) existing.push(entry);
    else candidates.set(name, [entry]);
  }

  for (const file of files) {
    let source: string;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }

    const isTsxFile = file.endsWith(".tsx") || file.endsWith(".jsx");
    const language = isTsxFile ? tsxLang : tsLang;

    let tree: { rootNode: TreeSitterNode };
    try {
      const parser = new ParserClass();
      parser.setLanguage(language);
      tree = parser.parse(source);
    } catch {
      continue;
    }

    function findComponents(node: TreeSitterNode): void {
      if (node.type === "function_declaration") {
        const nameNode = node.children.find((c) => c.type === "identifier");
        if (nameNode && isCapitalized(nameNode.text)) {
          const componentName = nameNode.text;
          addCandidate(componentName, {
            file,
            line: nameNode.startPosition.row + 1,
            col: nameNode.startPosition.column,
            isMemoized: isWrappedInMemo(source, componentName),
            hasUseCallback: nodeContainsCall(node, "useCallback"),
            hasUseMemo: nodeContainsCall(node, "useMemo"),
          });
        }
      } else if (node.type === "variable_declarator") {
        const nameNode = node.children[0];
        const valueNode = node.children[node.children.length - 1];
        const wrapper = reactWrapperCall(valueNode);
        if (
          nameNode &&
          nameNode.type === "identifier" &&
          isCapitalized(nameNode.text) &&
          valueNode &&
          (valueNode.type === "arrow_function" ||
            valueNode.type === "function_expression" ||
            wrapper.isWrapper)
        ) {
          const componentName = nameNode.text;
          addCandidate(componentName, {
            file,
            line: nameNode.startPosition.row + 1,
            col: nameNode.startPosition.column,
            isMemoized: isWrappedInMemo(source, componentName) || wrapper.isMemo,
            hasUseCallback: nodeContainsCall(node, "useCallback"),
            hasUseMemo: nodeContainsCall(node, "useMemo"),
          });
        }
      }

      for (const child of node.children) {
        findComponents(child);
      }
    }

    try {
      findComponents(tree.rootNode);
    } catch {
      // ignore parse errors for individual files
    }
  }

  for (const [name, entries] of candidates) {
    const { primary, others } = pickPrimary(entries);
    index.set(name, others.length > 0 ? { ...primary, otherMatches: others } : primary);
  }

  return { index, treeSitterAvailable: true, indexedFiles: files.length };
}
