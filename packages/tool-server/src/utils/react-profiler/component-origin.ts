/**
 * Guess whether a recorded component is the app's own code or a library's, for
 * the report's "Most Frequent Re-renders" rows. A raw table of the components that
 * re-render most is mostly React Native primitives, list internals and animation
 * wrappers; telling an agent about them only invites it to memoise cheap renders
 * it cannot change.
 *
 * Signals, in order:
 *
 * 1. Role. Animation wrappers (the 03-tag pattern), providers and contexts, and
 *    dev-only views are left out whoever defines them: they re-render to pass a
 *    value or drive a frame, and the cost that matters shows in what they render.
 * 2. React Native core and list-internal names (`View`, `Text`, `ScrollView`,
 *    `VirtualizedList`, `CellRenderer`, ...) are library, unless DevTools marks the
 *    fiber `Forget(...)`: the React Compiler compiles the app's code, not
 *    node_modules, so `Forget(Text)` is the app's own `Text` (Bluesky has one).
 * 3. Any other `Forget(...)` name is app code.
 * 4. The tree-sitter source index the File column uses. It walks the project and
 *    skips node_modules, so a name it knows is defined in the app's source and a
 *    name it does not know is taken to be a library's.
 * 5. No index (tree-sitter missing, wrong project root, no source files): only
 *    signals 1-3 apply and everything else is "unknown", which is kept.
 *
 * Known misses:
 * - Rows are keyed by display name, so an app component and a library component
 *   with the same name are one row and get one verdict. Without the compiler an
 *   app's own `View` or `Button` is dropped with React Native's.
 * - A library component not in the list below whose name the app also defines
 *   counts as app (react-native-screens' `Screen` in an app with its own `Screen`).
 * - The index sees function declarations and arrow/function/memo/forwardRef
 *   assignments only. App class components, components made by a factory or HOC
 *   (`styled.View`, `connect()`), and code outside the project root count as
 *   library, as do components in a plain .ts file over 32 KB or any file over
 *   512 KB, which the index skips. Libraries that ship React Compiler output
 *   count as app.
 * - Names DevTools cannot resolve (`Anonymous`) are left out.
 */
import { ANIMATED_PATTERN } from "./pipeline/03-tag";
import { astLookupCandidates, stripComponentWrappers } from "./component-names";

export type ComponentOrigin = "app" | "library" | "unknown";

export interface ComponentOriginResult {
  origin: ComponentOrigin;
  /** Source file of the app definition, when the index resolved one. */
  file?: string;
  line?: number;
}

/** The part of the AST index entry this module reads. */
export type ComponentSourceIndex = ReadonlyMap<string, { file: string; line: number }>;

// React Native core components and the internals they render.
const RN_CORE_NAMES = new Set([
  "ActivityIndicator",
  "AppContainer",
  "Button",
  "DrawerLayoutAndroid",
  "Image",
  "ImageBackground",
  "InputAccessoryView",
  "InternalTextInput",
  "KeyboardAvoidingView",
  "Modal",
  "Pressable",
  "RefreshControl",
  "SafeAreaView",
  "ScrollView",
  "ScrollViewBase",
  "ScrollViewStickyHeader",
  "StatusBar",
  "Switch",
  "Text",
  "TextImpl",
  "TextInput",
  "TouchableHighlight",
  "TouchableNativeFeedback",
  "TouchableOpacity",
  "TouchableWithoutFeedback",
  "View",
  // React built-ins and the label DevTools gives an unnamed function.
  "Anonymous",
  "Fragment",
  "Profiler",
  "StrictMode",
  "Suspense",
]);

// FlatList / SectionList / VirtualizedList internals and FlashList.
const LIST_INTERNALS_PATTERN =
  /^(FlatList|SectionList|VirtualizedList\w*|VirtualizedSectionList\w*|CellRenderer\w*|FlashList\w*|AutoLayoutView|CellContainer|RecyclerListView\w*)$/;

// Providers, contexts and their consumers: `ThemeProvider`, `ThemeContext.Provider`.
const PROVIDER_PATTERN = /(Provider|Context|\.Consumer)$/;

const DEV_ONLY_PATTERN =
  /^(PressabilityDebugView|LogBox\w*|DebuggingOverlay\w*|ReactDevToolsOverlay|Inspector\w*|DebugContainer)$/;

function isRoleExcluded(baseName: string): boolean {
  return (
    ANIMATED_PATTERN.test(baseName) ||
    PROVIDER_PATTERN.test(baseName) ||
    DEV_ONLY_PATTERN.test(baseName)
  );
}

function isReactNativeName(baseName: string): boolean {
  return RN_CORE_NAMES.has(baseName) || LIST_INTERNALS_PATTERN.test(baseName);
}

/**
 * @param index the analyze tool's source index, or null when it is unavailable;
 *   an empty index counts as unavailable, since it means the project root held
 *   no parseable source rather than that every component is a library's.
 */
export function createComponentOriginClassifier(
  index: ComponentSourceIndex | null
): (rawName: string) => ComponentOriginResult {
  const usableIndex = index && index.size > 0 ? index : null;
  return (rawName) => {
    const { baseName, hasForget } = stripComponentWrappers(rawName);
    if (isRoleExcluded(baseName)) return { origin: "library" };

    const entry = usableIndex
      ? astLookupCandidates(rawName)
          .map((k) => usableIndex.get(k))
          .find(Boolean)
      : undefined;
    const located = entry ? { file: entry.file, line: entry.line } : {};

    if (isReactNativeName(baseName)) {
      return hasForget ? { origin: "app", ...located } : { origin: "library" };
    }
    if (hasForget) return { origin: "app", ...located };
    if (!usableIndex) return { origin: "unknown" };
    return entry ? { origin: "app", ...located } : { origin: "library" };
  };
}
