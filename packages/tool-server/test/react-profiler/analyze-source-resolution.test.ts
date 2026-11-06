import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { reactProfilerAnalyzeTool } from "../../src/tools/profiler/react/react-profiler-analyze";
import { cacheProfilerPaths } from "../../src/blueprints/react-profiler-session";
import { buildAstIndexWithDiagnostics } from "../../src/utils/react-profiler/pipeline/06-resolve/ast-index";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function project(files: Record<string, string>): string {
  const root = makeTempDir("analyze-source-");
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const component = (name: string, marker: string) =>
  `export function ${name}() {\n  return <View testID="${marker}" />;\n}\n`;

let session = 0;

/** Run the real analyze tool on a session where `names` render in six hot commits. */
async function analyze(
  names: string[],
  params: { project_root: string; platform?: "ios" | "android" },
  options: { hotCommitIndices?: number[] | null; metroRoot?: string; bundleUrl?: string } = {}
): Promise<Record<string, unknown> & { report: string }> {
  const debugDir = makeTempDir("analyze-session-");
  const commits = [0, 1, 2, 3, 4, 5].flatMap((commitIndex) =>
    names.map((componentName) => ({
      commitIndex,
      timestamp: 100 * commitIndex + 50,
      componentName,
      actualDuration: 30,
      selfDuration: 30,
      commitDuration: 30,
      didRender: true,
      changeDescription: {
        props: ["data"],
        state: null,
        hooks: null,
        context: false,
        didHooksChange: false,
        isFirstMount: false,
      },
      hookTypes: null,
      parentName: null,
      isCompilerOptimized: false,
    }))
  );
  const commitsPath = join(debugDir, "commits.json");
  writeFileSync(
    commitsPath,
    JSON.stringify({ commits, meta: options.metroRoot ? { projectRoot: options.metroRoot } : {} })
  );
  let cpuProfilePath: string | null = null;
  if (options.bundleUrl) {
    cpuProfilePath = join(debugDir, "cpu.json");
    const callFrame = {
      functionName: "render",
      scriptId: "1",
      url: options.bundleUrl,
      lineNumber: 1,
      columnNumber: 1,
    };
    writeFileSync(
      cpuProfilePath,
      JSON.stringify({
        nodes: [{ id: 1, callFrame, hitCount: 1 }],
        startTime: 0,
        endTime: 1000,
        samples: [1],
        timeDeltas: [1000],
      })
    );
  }
  const device_id = `analyze-source-${session++}`;
  cacheProfilerPaths(
    8081,
    {
      sessionId: device_id,
      debugDir,
      cpuProfilePath,
      commitsPath,
      cpuSampleIndexPath: null,
      detectedArchitecture: "bridgeless",
      anyCompilerOptimized: false,
      hotCommitIndices:
        options.hotCommitIndices === undefined ? [0, 1, 2, 3, 4, 5] : options.hotCommitIndices,
      totalReactCommits: 6,
    },
    device_id
  );
  // Parse as the registry does, so an omitted platform takes the schema default.
  const parsed = reactProfilerAnalyzeTool.zodSchema!.parse({ device_id, ...params });
  const artifacts = {
    register: async ({ hostPath, kind }: { hostPath?: string; kind: string }) => ({
      id: hostPath ?? "none",
      kind,
    }),
  };
  return (await reactProfilerAnalyzeTool.execute(
    {},
    parsed as never,
    {
      artifacts,
    } as never
  )) as Record<string, unknown> & { report: string };
}

const fileCell = (report: string, name: string) =>
  report
    .split("\n")
    .find((line) => line.startsWith(`| \`${name}\``))
    ?.split("|")
    .at(-2)
    ?.trim();

describe("the file analyze gives for a name in several files", () => {
  const variants = {
    "src/List.ios.tsx": component("List", "IOS_MARKER"),
    "src/List.android.tsx": component("List", "ANDROID_MARKER"),
  };

  it("uses the profiled platform's variant in the table, the heading and the source", async () => {
    const root = project(variants);

    const ios = await analyze(["List"], { project_root: root, platform: "ios" });
    expect(fileCell(ios.report, "List")).toMatch(/^`src\/List\.ios\.tsx:1`/);
    expect(ios.report).toContain("### `List` — `src/List.ios.tsx:1`");
    expect(ios.report).toContain("IOS_MARKER");
    expect(ios.report).not.toContain("ANDROID_MARKER");

    const android = await analyze(["List"], { project_root: root, platform: "android" });
    expect(fileCell(android.report, "List")).toMatch(/^`src\/List\.android\.tsx:1`/);
    expect(android.report).toContain("ANDROID_MARKER");
    expect(android.report).not.toContain("IOS_MARKER");
  });

  it("names up to three other files, then counts the rest", async () => {
    const root = project({
      "a/Card.tsx": component("Card", "A"),
      "b/Card.tsx": component("Card", "B"),
      "c/Card.tsx": component("Card", "C"),
      "d/Card.tsx": component("Card", "D"),
      "e/Card.tsx": component("Card", "E"),
    });

    const { report } = await analyze(["Card"], { project_root: root, platform: "ios" });

    const hint = "`a/Card.tsx:1` (name also in b/Card.tsx:1, c/Card.tsx:1, d/Card.tsx:1, +1 more)";
    expect(fileCell(report, "Card")).toBe(hint);
    expect(report).toContain(`### \`Card\` — ${hint}`);
  });

  it("adds no hint to a name in one file", async () => {
    const root = project({ "src/Solo.tsx": component("Solo", "SOLO") });

    const { report } = await analyze(["Solo"], { project_root: root, platform: "ios" });

    expect(fileCell(report, "Solo")).toBe("`src/Solo.tsx:1`");
  });
});

describe("the warning analyze gives when it cannot locate source", () => {
  it("warns for a root that does not exist, and still returns the report", async () => {
    const result = await analyze(["List"], { project_root: "/nonexistent/remote/checkout" });

    expect(result.warning).toContain('project_root "/nonexistent/remote/checkout"');
    expect(result.report).toContain("`List`");
    expect(fileCell(result.report, "List")).toBe("—");
  });

  it("warns for a folder with no source files", async () => {
    const result = await analyze(["List"], { project_root: project({ "app.json": "{}" }) });

    expect(result.warning).toContain("0 source files");
  });

  it("gives no warning for a healthy project", async () => {
    const root = project({ "src/List.tsx": component("List", "BASE") });

    const result = await analyze(["List"], { project_root: root });

    expect(result.warning).toBeUndefined();
  });

  it("joins this warning to the one for missing commit data", async () => {
    const result = await analyze(
      ["List"],
      { project_root: "/nonexistent/remote/checkout" },
      { hotCommitIndices: null }
    );

    expect(result.warning).toContain("No React commit data");
    expect(result.warning).toContain("check project_root");
  });

  it("puts the warning before the report in the result", async () => {
    const result = await analyze(["List"], { project_root: "/nonexistent/remote/checkout" });

    expect(Object.keys(result)[0]).toBe("warning");
  });

  it("warns when the root holds source but no component in the report", async () => {
    const root = project({ "src/util.ts": "export const a = 1;\n" });

    const result = await analyze(["List"], { project_root: root });

    expect(result.warning).toContain("1 source files");
  });

  it("warns when only a subfolder was indexed and nothing matched", async () => {
    const root = project({ "src/lib/Helper.tsx": component("Helper", "H") });

    const result = await analyze(["List"], { project_root: join(root, "src/lib") });

    expect(result.warning).toContain("check project_root");
  });

  it("uses Metro's root when project_root holds nothing, and says so", async () => {
    const metroRoot = project({ "src/List.tsx": component("List", "BASE") });

    const result = await analyze(["List"], { project_root: "/client/only/path" }, { metroRoot });

    expect(fileCell(result.report, "List")).toBe("`src/List.tsx:1`");
    expect(result.warning).toContain(`Metro's project root "${metroRoot}"`);
  });

  it("warns when project_root is a real project but not the one Metro serves", async () => {
    const metroRoot = project({ "src/List.tsx": component("List", "REAL") });
    const other = project({ "src/List.tsx": component("List", "OTHER") });

    const result = await analyze(["List"], { project_root: other }, { metroRoot });

    expect(result.warning).toContain(`Metro serves this app from "${metroRoot}"`);
  });

  it("accepts a monorepo root around Metro's root, and Metro's root itself", async () => {
    const monorepo = project({
      "apps/mobile/src/List.tsx": component("List", "BASE"),
    });
    const metroRoot = join(monorepo, "apps/mobile");

    const around = await analyze(["List"], { project_root: monorepo }, { metroRoot });
    const same = await analyze(["List"], { project_root: metroRoot }, { metroRoot });

    expect(around.warning).toBeUndefined();
    expect(same.warning).toBeUndefined();
  });
});

describe("which file wins among modules", () => {
  it("does not let a helper in an unrelated .ios or .native file beat the real base file", async () => {
    const helper = `function Button() {\n  return <View testID="HELPER" />;\n}\n`;
    const root = project({
      "src/components/Button.tsx": component("Button", "REAL"),
      "src/view/Other.ios.tsx": helper,
      "src/view/Thing.native.tsx": helper,
    });

    const { report } = await analyze(["Button"], { project_root: root, platform: "ios" });

    expect(fileCell(report, "Button")).toMatch(/^`src\/components\/Button\.tsx:1`/);
    expect(report).not.toContain("HELPER");
  });

  it("prefers the file named after the component, and keeps the rest as a hint", async () => {
    const root = project({
      "src/components/Admonition.tsx": `export function Admonition() {\n  return <Button />;\n}\n${component("Button", "HELPER")}`,
      "src/components/Button.tsx": component("Button", "REAL"),
    });

    const { report } = await analyze(["Button"], { project_root: root, platform: "ios" });

    expect(fileCell(report, "Button")).toBe(
      "`src/components/Button.tsx:1` (name also in src/components/Admonition.tsx:4)"
    );
    expect(report).toContain("REAL");
    expect(report).not.toContain("HELPER");
  });

  it("does not name a file the profiled platform never loads", async () => {
    const root = project({
      "src/List.ios.tsx": component("List", "IOS"),
      "src/List.android.tsx": component("List", "ANDROID"),
    });

    const { report } = await analyze(["List"], { project_root: root, platform: "ios" });

    expect(fileCell(report, "List")).toBe("`src/List.ios.tsx:1`");
  });
});

describe("which platform analyze uses", () => {
  const variants = {
    "src/List.ios.tsx": component("List", "IOS"),
    "src/List.android.tsx": component("List", "ANDROID"),
  };
  const bundle = (platform: string) =>
    `http://localhost:8081/index.bundle?platform=${platform}&dev=true&hot=false`;

  it("reads the platform from the recording when the caller omits it", async () => {
    const root = project(variants);

    const { report } = await analyze(
      ["List"],
      { project_root: root },
      { bundleUrl: bundle("android") }
    );

    expect(fileCell(report, "List")).toBe("`src/List.android.tsx:1`");
  });

  it("trusts the recording over a wrong platform argument", async () => {
    const root = project(variants);

    const { report } = await analyze(
      ["List"],
      { project_root: root, platform: "ios" },
      { bundleUrl: bundle("android") }
    );

    expect(fileCell(report, "List")).toBe("`src/List.android.tsx:1`");
  });

  it("reads a real Metro URL with its doubled slash", async () => {
    const root = project(variants);

    const { report } = await analyze(
      ["List"],
      { project_root: root },
      { bundleUrl: "http://127.0.0.1:8117/index.ts.bundle//&platform=android&dev=true&hot=false" }
    );

    expect(fileCell(report, "List")).toBe("`src/List.android.tsx:1`");
  });

  it("drops nothing and names both files when no one knows the platform", async () => {
    const root = project(variants);

    const { report } = await analyze(["List"], { project_root: root });

    expect(fileCell(report, "List")).toBe(
      "`src/List.android.tsx:1` (name also in src/List.ios.tsx:1)"
    );
  });
});

describe("buildAstIndexWithDiagnostics with a platform", () => {
  const list = (marker: string) => component("List", marker);
  const entry = (marker: string) => component("PokemonEntry", marker);

  async function primary(files: Record<string, string>, platform?: "ios" | "android") {
    const root = project(files);
    const { index } = await buildAstIndexWithDiagnostics(root, platform);
    return index.get("List")?.file.slice(root.length + 1);
  }

  it("follows Metro's order: platform, then native, then base", async () => {
    const all = {
      "src/List.tsx": list("BASE"),
      "src/List.native.tsx": list("NATIVE"),
      "src/List.ios.tsx": list("IOS"),
      "src/List.android.tsx": list("ANDROID"),
    };
    expect(await primary(all, "ios")).toBe("src/List.ios.tsx");
    expect(await primary(all, "android")).toBe("src/List.android.tsx");
    expect(
      await primary({ "src/List.tsx": list("BASE"), "src/List.native.tsx": list("N") }, "ios")
    ).toBe("src/List.native.tsx");
  });

  it("puts the base file above the other platform's variant", async () => {
    const files = { "src/List.tsx": list("BASE"), "src/List.ios.tsx": list("IOS") };
    expect(await primary(files, "android")).toBe("src/List.tsx");
  });

  it("drops .web files for a native platform, and only then", async () => {
    const files = { "src/List.web.tsx": list("WEB") };
    expect(await primary(files, "ios")).toBeUndefined();
    expect(await primary(files, "android")).toBeUndefined();
    expect(await primary(files)).toBe("src/List.web.tsx");
  });

  it("keeps one file per module, so shadowed and unbundled variants leave no hint", async () => {
    const root = project({
      "src/List.tsx": list("BASE"),
      "src/List.native.tsx": list("NATIVE"),
      "src/List.ios.tsx": list("IOS"),
      "src/List.android.tsx": list("ANDROID"),
      "src/List.web.tsx": list("WEB"),
    });

    const { index } = await buildAstIndexWithDiagnostics(root, "ios");

    expect(index.get("List")?.file).toBe(join(root, "src/List.ios.tsx"));
    expect(index.get("List")?.otherMatches).toBeUndefined();
  });

  it("drops a name found only in the other platform's file", async () => {
    expect(await primary({ "src/List.android.tsx": list("A") }, "ios")).toBeUndefined();
  });

  it("matches file names in any case and with separators, and index files by folder", async () => {
    const exact = { "a/Zed.tsx": list("Z"), "b/List.tsx": list("L") };
    expect(await primary(exact, "ios")).toBe("b/List.tsx");
    const kebab = { "a/Zed.tsx": list("Z"), "b/list.tsx": list("L") };
    expect(await primary(kebab, "ios")).toBe("b/list.tsx");
    const folder = { "a/Zed.tsx": list("Z"), "b/List/index.tsx": list("L") };
    expect(await primary(folder, "ios")).toBe("b/List/index.tsx");
  });

  it("lets a kebab-case file tie with an exact name, so a stale copy gains no edge", async () => {
    const files = {
      "a/pokemon-entry.tsx": entry("REAL"),
      "z-legacy/PokemonEntry.tsx": entry("OLD"),
    };
    const root = project(files);
    const { index } = await buildAstIndexWithDiagnostics(root, "ios");
    expect(index.get("PokemonEntry")?.file).toBe(join(root, "a/pokemon-entry.tsx"));
  });

  it("ranks app code above a nested package and stories, whatever their file names", async () => {
    const files = {
      "embed/package.json": "{}",
      "embed/src/List.tsx": list("OTHER_PACKAGE"),
      "src/List.stories.tsx": list("STORY"),
      "src/screens/Feed.tsx": list("APP"),
    };
    expect(await primary(files, "ios")).toBe("src/screens/Feed.tsx");
  });

  it("keeps the old order with no platform, as react-profiler-component-source calls it", async () => {
    const files = { "src/List.ios.tsx": list("IOS"), "src/List.android.tsx": list("ANDROID") };
    expect(await primary(files)).toBe("src/List.android.tsx");
    expect(await primary({ "src/List.tsx": list("BASE"), "src/List.ios.tsx": list("IOS") })).toBe(
      "src/List.tsx"
    );
  });
});
