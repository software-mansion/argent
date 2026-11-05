import { promises as fs } from "fs";
import { join } from "path";

const _require = require;

interface TreeSitterNode {
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
  parse(
    src: string,
    oldTree?: undefined,
    options?: { bufferSize?: number }
  ): { rootNode: TreeSitterNode };
}

type ParserCtor = new () => ParserInstance;

interface ComponentMatch {
  file: string;
  line: number; // 1-based
  col: number; // 0-based
}

interface ComponentIndexEntry {
  file: string;
  line: number; // 1-based
  col: number; // 0-based
  isMemoized: boolean;
  hasUseCallback: boolean;
  hasUseMemo: boolean;
  // Same-named components elsewhere, usually platform variants (List.tsx vs
  // List.web.tsx). The fields above hold the primary match; these expose the
  // rest so a caller can tell an ambiguous name from a single definite hit.
  otherMatches?: ComponentMatch[];
}

type ComponentIndex = Map<string, ComponentIndexEntry>;

interface AstIndexResult {
  index: ComponentIndex;
  treeSitterAvailable: boolean;
  indexedFiles: number;
}

// Loaded lazily: a missing or uncompiled tree-sitter degrades to an empty index.

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
    return null;
  }

  if (!_ParserClass || !_tsLanguage || !_tsxLanguage) return null;
  return { ParserClass: _ParserClass, ts: _tsLanguage, tsx: _tsxLanguage };
}

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "android",
  "ios",
  "dist",
  "build",
  ".expo",
  "__tests__",
  "__mocks__",
]);

/** A mock defined in a test is not the app's component, though it may share its name. */
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;

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
          (name.endsWith(".ts") ||
            name.endsWith(".tsx") ||
            name.endsWith(".js") ||
            name.endsWith(".jsx")) &&
          !TEST_FILE.test(name)
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
 * Match memo()/forwardRef(), including React.* and nesting such as
 * memo(forwardRef(...)) — only the outer callee is checked. Without this,
 * `const X = memo(...)` is just a call_expression value and never indexed.
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

/**
 * Names passed by reference to memo(), e.g. `function Card() {}; export default
 * memo(Card)` — the cross-reference form reactWrapperCall misses, since it only
 * inspects a declarator's value node.
 */
function collectMemoizedNames(root: TreeSitterNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: TreeSitterNode): void => {
    if (node.type === "call_expression" && reactWrapperCall(node).isMemo) {
      const args = node.children.find((c) => c.type === "arguments");
      const arg = args?.children.find((c) => c.type === "identifier");
      if (arg) names.add(arg.text);
    }
    for (const c of node.children) visit(c);
  };
  visit(root);
  return names;
}

// Metro resolves .ios/.android/.native/.web over the base file only when
// bundling for that platform, so the base file is the general default and wins
// as primary when one component name exists in several files.
const PLATFORM_SUFFIX = /\.(web|ios|android|native)\.[jt]sx?$/;

function isPlatformVariant(file: string): boolean {
  return PLATFORM_SUFFIX.test(file);
}

/**
 * Split same-named candidates into a primary plus the rest, walk-order
 * independently: base files before platform variants, then path, line, column.
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

/** What tree-sitter parses with its default 32 KB buffer. */
const DEFAULT_PARSE_BUFFER_CHARS = 32 * 1024 - 1;
/** Over this a file is generated or vendored, not a screen someone wrote. */
const MAX_JSX_FILE_CHARS = 512 * 1024;

/**
 * Index every React component in the project. Without tree-sitter, returns an
 * empty index and treeSitterAvailable=false rather than throwing.
 */
export async function buildAstIndexWithDiagnostics(projectRoot: string): Promise<AstIndexResult> {
  const index: ComponentIndex = new Map();

  const ts = loadTreeSitter();
  if (!ts) return { index, treeSitterAvailable: false, indexedFiles: 0 };

  const { ParserClass, ts: tsLang, tsx: tsxLang } = ts;

  const files = await findSourceFiles(projectRoot);

  // Resolve the primary only once every file is walked; picking during the walk
  // would re-tie the result to directory-walk order.
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

    // JSX is common in plain .js files (an Expo App.js); the TypeScript grammar
    // fails at the first tag and drops every component after it. TSX parses all
    // of JavaScript, so only .ts, where `<T>value` casts conflict with JSX, keeps
    // the TypeScript grammar.
    const isTsxFile = file.endsWith(".tsx") || file.endsWith(".jsx") || file.endsWith(".js");
    const language = isTsxFile ? tsxLang : tsLang;
    // Walking a tree is the slow part, not parsing it. Large plain .ts files hold
    // data, not components: Bluesky's 55 cost about 3 s of CPU and add no names,
    // while its 13 large .tsx files are real screens.
    if (source.length > (isTsxFile ? MAX_JSX_FILE_CHARS : DEFAULT_PARSE_BUFFER_CHARS)) continue;

    let tree: { rootNode: TreeSitterNode };
    try {
      const parser = new ParserClass();
      parser.setLanguage(language);
      // The binding's default buffer rejects larger files with "Invalid argument".
      // The size is in UTF-16 code units, plus one for the terminator.
      tree = parser.parse(source, undefined, { bufferSize: source.length + 1 });
    } catch {
      continue;
    }

    let memoizedNames: ReturnType<typeof collectMemoizedNames>;
    try {
      memoizedNames = collectMemoizedNames(tree.rootNode);
    } catch {
      // A generated expression can nest past the stack limit; skip that file, not the index.
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
            isMemoized: memoizedNames.has(componentName),
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
            isMemoized: memoizedNames.has(componentName) || wrapper.isMemo,
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
      /* best-effort */
    }
  }

  for (const [name, entries] of candidates) {
    const { primary, others } = pickPrimary(entries);
    index.set(name, others.length > 0 ? { ...primary, otherMatches: others } : primary);
  }

  return { index, treeSitterAvailable: true, indexedFiles: files.length };
}
