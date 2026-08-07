import { describe, it, expect } from "vitest";
import { SourceMapGenerator } from "source-map-js";
import { SourceMapsRegistry } from "../../src/utils/debugger/source-maps";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";

const BUNDLE_URL = "http://localhost:8081/index.bundle//&platform=ios&dev=true";

const CONSOLE_POLYFILL = "/[metro-project]/node_modules/@react-native/js-polyfills/console.js";
const LOGBOX = "/[metro-project]/node_modules/react-native/Libraries/LogBox/LogBox.js";
const APP_SCREEN = "/[metro-project]/app/(tabs)/index.tsx";
const APP_COMPONENT = "/[metro-project]/components/hello-wave.tsx";

/**
 * A source map shaped like Metro's: one bundle, sources for both runtime and app code,
 * and an ignore list covering the runtime ones.
 *
 * Mappings deliberately start at a non-zero column. Real bundle output is indented, so a
 * call frame's column routinely precedes the first mapping on its line — a fixture with
 * everything at column 0 would never exercise that.
 */
function metroShapedMap(
  opts: { ignoreList?: number[] | unknown; ignoreListKey?: string; extra?: object } = {}
): string {
  const gen = new SourceMapGenerator({ file: "index.bundle" });
  const mappings: Array<[number, number, string, number]> = [
    [1161, 39, CONSOLE_POLYFILL, 661],
    [65241, 34, CONSOLE_POLYFILL, 42],
    [6125, 27, LOGBOX, 222],
    [190458, 15, APP_SCREEN, 11],
    [190821, 16, APP_COMPONENT, 4],
  ];
  for (const [line, column, source, originalLine] of mappings) {
    gen.addMapping({
      generated: { line, column },
      original: { line: originalLine, column: 0 },
      source,
    });
  }

  const raw: Record<string, unknown> = JSON.parse(gen.toString());
  const key = opts.ignoreListKey ?? "x_google_ignoreList";
  if (opts.ignoreList !== undefined) raw[key] = opts.ignoreList;
  Object.assign(raw, opts.extra ?? {});

  return `data:application/json;base64,${Buffer.from(JSON.stringify(raw)).toString("base64")}`;
}

async function registryWith(
  sourceMapURL: string,
  opts: { scriptId?: string; scriptUrl?: string; projectRoot?: string } = {}
) {
  const registry = new SourceMapsRegistry(opts.projectRoot ?? "/[metro-project]");
  registry.registerFromScriptParsed(
    opts.scriptUrl ?? BUNDLE_URL,
    opts.scriptId ?? "2",
    sourceMapURL
  );
  await registry.waitForPending();
  return registry;
}

/** Indices of the two runtime sources in the fixture's `sources` array. */
async function runtimeIndices(sourceMapURL: string): Promise<number[]> {
  const raw = JSON.parse(Buffer.from(sourceMapURL.split(",")[1], "base64").toString("utf-8"));
  return [raw.sources.indexOf(CONSOLE_POLYFILL), raw.sources.indexOf(LOGBOX)];
}

describe("SourceMapsRegistry.toOriginalPosition", () => {
  it("resolves a 0-based bundle line to a 1-based original line", async () => {
    const url = metroShapedMap();
    const registry = await registryWith(url);

    // CDP reports the app frame at bundle line 190457 (0-based) = generated line 190458.
    const pos = registry.toOriginalPosition({
      scriptId: "2",
      scriptUrl: BUNDLE_URL,
      line0Based: 190457,
      column0Based: 15,
    });

    expect(pos).not.toBeNull();
    expect(pos!.source).toBe(APP_SCREEN);
    expect(pos!.line1Based).toBe(11);
  });

  it("recovers a frame whose column precedes the first mapping on its line", async () => {
    const registry = await registryWith(metroShapedMap());

    // Column 1 sits before the mapping at column 15; a lower-bound search alone finds
    // nothing here, which would silently drop the only attributable frame in the stack.
    const pos = registry.toOriginalPosition({
      scriptId: "2",
      scriptUrl: BUNDLE_URL,
      line0Based: 190457,
      column0Based: 1,
    });

    expect(pos?.source).toBe(APP_SCREEN);
    expect(pos?.line1Based).toBe(11);
  });

  it("returns null for a generated line with no mapping rather than a neighbouring one", async () => {
    const registry = await registryWith(metroShapedMap());

    const pos = registry.toOriginalPosition({
      scriptId: "2",
      scriptUrl: BUNDLE_URL,
      line0Based: 500000,
      column0Based: 0,
    });

    expect(pos).toBeNull();
  });

  it("reports hasMaps only once a map is registered", async () => {
    const registry = new SourceMapsRegistry("/[metro-project]");
    expect(registry.hasMaps()).toBe(false);

    registry.registerFromScriptParsed(BUNDLE_URL, "2", metroShapedMap());
    await registry.waitForPending();

    expect(registry.hasMaps()).toBe(true);
  });

  describe("ignore list", () => {
    it("marks runtime sources from x_google_ignoreList and leaves app sources attributable", async () => {
      const base = metroShapedMap();
      const url = metroShapedMap({ ignoreList: await runtimeIndices(base) });
      const registry = await registryWith(url);

      const runtime = registry.toOriginalPosition({
        scriptId: "2",
        line0Based: 1160,
        column0Based: 39,
      });
      const app = registry.toOriginalPosition({
        scriptId: "2",
        line0Based: 190457,
        column0Based: 15,
      });

      expect(runtime?.ignoreListed).toBe(true);
      expect(runtime?.ignoreListAvailable).toBe(true);
      expect(app?.ignoreListed).toBe(false);
      expect(app?.ignoreListAvailable).toBe(true);
    });

    it("accepts the `ignoreList` spelling", async () => {
      const base = metroShapedMap();
      const url = metroShapedMap({
        ignoreList: await runtimeIndices(base),
        ignoreListKey: "ignoreList",
      });
      const registry = await registryWith(url);

      const runtime = registry.toOriginalPosition({
        scriptId: "2",
        line0Based: 1160,
        column0Based: 39,
      });
      expect(runtime?.ignoreListed).toBe(true);
    });

    it("distinguishes an absent ignore list from an empty one", async () => {
      const absent = await registryWith(metroShapedMap());
      const empty = await registryWith(metroShapedMap({ ignoreList: [] }));

      const query = { scriptId: "2", line0Based: 1160, column0Based: 39 };
      expect(absent.toOriginalPosition(query)?.ignoreListAvailable).toBe(false);
      expect(empty.toOriginalPosition(query)?.ignoreListAvailable).toBe(true);
      expect(empty.toOriginalPosition(query)?.ignoreListed).toBe(false);
    });

    it("ignores malformed entries without discarding the map", async () => {
      const url = metroShapedMap({ ignoreList: ["0", -1, 9999, 1.5, null, 0] });
      const registry = await registryWith(url);

      const pos = registry.toOriginalPosition({
        scriptId: "2",
        line0Based: 1160,
        column0Based: 39,
      });
      expect(pos).not.toBeNull();
      expect(pos!.ignoreListed).toBe(true);
    });

    it("treats a non-array ignore list as absent", async () => {
      const registry = await registryWith(metroShapedMap({ ignoreList: "nope" }));

      const pos = registry.toOriginalPosition({
        scriptId: "2",
        line0Based: 1160,
        column0Based: 39,
      });
      expect(pos?.ignoreListAvailable).toBe(false);
    });

    it("does not hide a source that another index also names", async () => {
      // Normalisation can collapse two entries onto one string. If one of them is
      // ignore-listed and the other is app code, hiding the shared name would drop a real
      // call site, so the ambiguous case has to stay attributable.
      const gen = new SourceMapGenerator({ file: "index.bundle" });
      gen.addMapping({
        generated: { line: 10, column: 2 },
        original: { line: 1, column: 0 },
        source: "app/./shared.tsx",
      });
      gen.addMapping({
        generated: { line: 20, column: 2 },
        original: { line: 2, column: 0 },
        source: "app/shared.tsx",
      });
      const raw = JSON.parse(gen.toString());
      raw.x_google_ignoreList = [0];
      const url = `data:application/json;base64,${Buffer.from(JSON.stringify(raw)).toString("base64")}`;

      const registry = await registryWith(url);
      const pos = registry.toOriginalPosition({ scriptId: "2", line0Based: 19, column0Based: 2 });

      expect(pos?.ignoreListed).toBe(false);
    });

    it("survives a sectioned map without applying its indices to the wrong sources", async () => {
      // A sectioned map carries its sources per section, so indices into a flat `sources`
      // array mean nothing. Registering one must not throw, and must not attribute.
      const url = metroShapedMap({ ignoreList: [0], extra: { sections: [] } });
      const registry = await registryWith(url);

      expect(
        registry.toOriginalPosition({ scriptId: "2", line0Based: 1160, column0Based: 39 })
      ).toBeNull();
      // A later flat map still registers and resolves normally.
      registry.registerFromScriptParsed("http://localhost:8081/next.bundle", "3", metroShapedMap());
      await registry.waitForPending();
      expect(
        registry.toOriginalPosition({ scriptId: "3", line0Based: 190457, column0Based: 15 })?.source
      ).toBe(APP_SCREEN);
    });
  });

  describe("map selection", () => {
    it("prefers an exact scriptId over a same-URL map registered earlier", async () => {
      const registry = new SourceMapsRegistry("/[metro-project]");
      registry.registerFromScriptParsed(BUNDLE_URL, "2", metroShapedMap());
      registry.registerFromScriptParsed(
        "http://localhost:8081/other.bundle",
        "7",
        metroShapedMap()
      );
      await registry.waitForPending();

      const pos = registry.toOriginalPosition({
        scriptId: "2",
        scriptUrl: BUNDLE_URL,
        line0Based: 190457,
        column0Based: 15,
      });
      expect(pos?.source).toBe(APP_SCREEN);
    });

    it("matches on URL when the scriptId is unknown", async () => {
      const registry = await registryWith(metroShapedMap());

      const pos = registry.toOriginalPosition({
        scriptId: "unknown",
        scriptUrl: BUNDLE_URL,
        line0Based: 190457,
        column0Based: 15,
      });
      expect(pos?.source).toBe(APP_SCREEN);
    });

    it("matches a URL that differs only in its query string", async () => {
      // Note this does not apply to Metro, which puts its parameters in the path
      // (`/index.bundle//&platform=ios`) — those are matched exactly, by the rule above.
      const registry = await registryWith(metroShapedMap(), {
        scriptUrl: "http://localhost:3000/app.js?v=1",
      });

      const pos = registry.toOriginalPosition({
        scriptId: "unknown",
        scriptUrl: "http://localhost:3000/app.js?v=2",
        line0Based: 190457,
        column0Based: 15,
      });
      expect(pos?.source).toBe(APP_SCREEN);
    });

    it("returns null for a script it has no map for, rather than guessing", async () => {
      // Resolving one script's frame against another script's map yields a real-looking
      // file and line that is simply wrong — worse than reporting nothing.
      const registry = await registryWith(metroShapedMap());

      const pos = registry.toOriginalPosition({
        scriptId: "9",
        scriptUrl: "http://localhost:8081/lazy-chunk.bundle",
        line0Based: 190457,
        column0Based: 15,
      });
      expect(pos).toBeNull();
    });

    it("prefers the newest map after a reload re-registers the same URL", async () => {
      const registry = new SourceMapsRegistry("/[metro-project]");
      registry.registerFromScriptParsed(BUNDLE_URL, "2", metroShapedMap());
      await registry.waitForPending();

      // The reloaded bundle maps the same generated position to a different source.
      const gen = new SourceMapGenerator({ file: "index.bundle" });
      gen.addMapping({
        generated: { line: 190458, column: 15 },
        original: { line: 99, column: 0 },
        source: "/[metro-project]/app/reloaded.tsx",
      });
      const reloaded = `data:application/json;base64,${Buffer.from(gen.toString()).toString("base64")}`;
      registry.registerFromScriptParsed(BUNDLE_URL, "12", reloaded);
      await registry.waitForPending();

      const pos = registry.toOriginalPosition({
        scriptUrl: BUNDLE_URL,
        line0Based: 190457,
        column0Based: 15,
      });
      expect(pos?.source).toBe("/[metro-project]/app/reloaded.tsx");
      expect(pos?.line1Based).toBe(99);
    });

    it("keeps only the most recent maps so long sessions do not accumulate them", async () => {
      const registry = new SourceMapsRegistry("/[metro-project]");
      for (let i = 0; i < 10; i++) {
        registry.registerFromScriptParsed(
          `http://localhost:8081/chunk-${i}.bundle`,
          `${i}`,
          metroShapedMap()
        );
      }
      await registry.waitForPending();

      // The newest registration still resolves; the oldest has been evicted.
      expect(
        registry.toOriginalPosition({ scriptId: "9", line0Based: 190457, column0Based: 15 })
      ).not.toBeNull();
      expect(
        registry.toOriginalPosition({ scriptId: "0", line0Based: 190457, column0Based: 15 })
      ).toBeNull();
    });
  });
});

describe("log attribution end to end (real registry + real writer)", () => {
  it("attributes each log to the app file and line that emitted it", async () => {
    const base = metroShapedMap();
    const registry = await registryWith(metroShapedMap({ ignoreList: await runtimeIndices(base) }));
    const writer = new LogFileWriter(8081, registry);

    // The frame shapes captured from a live React Native app: every console call enters
    // through the polyfill at bundle line 1160, so frame 0 is identical for all of them.
    const bundleFrame = (lineNumber: number) => ({
      functionName: "f",
      scriptId: "2",
      url: BUNDLE_URL,
      lineNumber,
      columnNumber: 15,
    });

    writer.write({
      id: 0,
      timestamp: "2026-07-31T18:02:43.175Z",
      level: "log",
      message: 'Running "main" with {"rootTag":11}',
      stackTrace: { callFrames: [bundleFrame(1160), bundleFrame(65240)] },
    });
    writer.write({
      id: 1,
      timestamp: "2026-07-31T18:02:43.402Z",
      level: "log",
      message: "ARGENT_PROBE_HOME",
      stackTrace: { callFrames: [bundleFrame(1160), bundleFrame(65240), bundleFrame(190457)] },
    });
    writer.write({
      id: 2,
      timestamp: "2026-07-31T18:02:43.417Z",
      level: "warning",
      message: "ARGENT_PROBE_WAVE",
      stackTrace: {
        callFrames: [bundleFrame(1160), bundleFrame(6124), bundleFrame(190820)],
      },
    });

    try {
      const clusters = writer.getClusters();
      const byMessage = (m: string) => clusters.find((c) => c.message.startsWith(m));

      expect(byMessage("ARGENT_PROBE_HOME")).toMatchObject({
        sourceFile: "app/(tabs)/index.tsx",
        sourceLine: 11,
      });
      expect(byMessage("ARGENT_PROBE_WAVE")).toMatchObject({
        sourceFile: "components/hello-wave.tsx",
        sourceLine: 4,
      });

      // A log with no app frame is left unattributed rather than pinned to the polyfill.
      expect(byMessage('Running "main"')?.sourceFile).toBeUndefined();

      // The polyfill's own position must not appear anywhere.
      expect(clusters.some((c) => c.sourceLine === 1160)).toBe(false);
      expect(clusters.some((c) => c.sourceLine === 661)).toBe(false);

      // File and line are always present together.
      for (const c of clusters) {
        expect(c.sourceFile === undefined).toBe(c.sourceLine === undefined);
      }

      // The flat file carries the same attribution, greppable as `path:line`.
      const flat = require("node:fs").readFileSync(writer.getFilePath(), "utf-8") as string;
      expect(flat).toContain("app/(tabs)/index.tsx:11 | ARGENT_PROBE_HOME");
      expect(flat).toContain("components/hello-wave.tsx:4 | ARGENT_PROBE_WAVE");
      expect(flat).toContain('- | Running "main"');
    } finally {
      writer.close();
    }
  });

  it("round-trips a flat line whose source path contains a space", async () => {
    const gen = new SourceMapGenerator({ file: "index.bundle" });
    gen.addMapping({
      generated: { line: 100, column: 2 },
      original: { line: 7, column: 0 },
      source: "/Users/me/My Project/app/index.tsx",
    });
    const url = `data:application/json;base64,${Buffer.from(gen.toString()).toString("base64")}`;
    const registry = await registryWith(url, { projectRoot: "/Users/me/My Project" });
    const writer = new LogFileWriter(8081, registry);

    writer.write({
      id: 0,
      timestamp: "2026-07-31T18:02:43.175Z",
      level: "log",
      message: "spaced",
      stackTrace: {
        callFrames: [
          { functionName: "f", scriptId: "2", url: BUNDLE_URL, lineNumber: 99, columnNumber: 2 },
        ],
      },
    });

    try {
      expect(writer.getClusters()[0]).toMatchObject({
        sourceFile: "app/index.tsx",
        sourceLine: 7,
      });
      // A space in the source column must not shift the message out of the parsed line.
      const entries = writer.readAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("spaced");
    } finally {
      writer.close();
    }
  });
});
