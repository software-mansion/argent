import { describe, it, expect } from "vitest";
import {
  attributeLogSource,
  cleanSourceUrl,
  normalizeMapSource,
  toFlatSourceToken,
  type LogFrameMapper,
} from "../../src/utils/debugger/log-source-attribution";
import type { OriginalLocation } from "../../src/utils/debugger/source-maps";

const BUNDLE_URL =
  "http://localhost:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true";

/** A call frame as CDP reports it — every React Native frame shares one bundle script. */
function frame(lineNumber: number, functionName = "anonymous") {
  return { functionName, scriptId: "2", url: BUNDLE_URL, lineNumber, columnNumber: 10 };
}

function location(source: string, line1Based: number, opts: Partial<OriginalLocation> = {}) {
  return {
    source,
    line1Based,
    column0Based: 0,
    name: null,
    ignoreListed: false,
    ignoreListAvailable: true,
    ...opts,
  };
}

/**
 * A mapper backed by a fixed generated-line → original-location table, so each test
 * states the exact stack shape it is about.
 */
function mapperFor(
  table: Record<number, OriginalLocation | null>,
  opts: { calls?: number[]; projectRoot?: string } = {}
): LogFrameMapper {
  return {
    projectRoot: opts.projectRoot,
    hasMaps: () => true,
    toOriginalPosition: (f) => {
      opts.calls?.push(f.line0Based);
      return table[f.line0Based] ?? null;
    },
  };
}

describe("attributeLogSource", () => {
  it("skips the console polyfill and attributes to the app frame that logged", () => {
    // The shape captured from a live RN app: every console.* call enters through the
    // same polyfill, so frame 0 is a constant position for every log ever emitted.
    const source = attributeLogSource(
      {
        callFrames: [frame(1160), frame(65240), frame(190457, "HomeScreen"), frame(27036)],
      },
      mapperFor({
        1160: location("/[metro-project]/node_modules/@react-native/js-polyfills/console.js", 661, {
          ignoreListed: true,
        }),
        65240: location(
          "/[metro-project]/node_modules/react-native/Libraries/Core/setUpDeveloperTools.js",
          42,
          { ignoreListed: true }
        ),
        190457: location("/[metro-project]/app/(tabs)/index.tsx", 11),
        27036: location("/[metro-project]/node_modules/react-native/Libraries/Renderer/x.js", 1, {
          ignoreListed: true,
        }),
      })
    );

    expect(source).toEqual({ file: "app/(tabs)/index.tsx", line: 11 });
  });

  it("reaches past several layers of warning plumbing to the app frame", () => {
    const source = attributeLogSource(
      {
        callFrames: [
          frame(1160),
          frame(57574, "overrideMethod"),
          frame(65240),
          frame(6124, "registerWarning"),
          frame(6020),
          frame(190820, "HelloWave"),
        ],
      },
      mapperFor({
        1160: location("/[metro-project]/node_modules/@react-native/js-polyfills/console.js", 661, {
          ignoreListed: true,
        }),
        57574: location(
          "/[metro-project]/node_modules/react-devtools-core/dist/backend.js",
          17416,
          {
            ignoreListed: true,
          }
        ),
        65240: location("/[metro-project]/node_modules/react-native/Libraries/Core/x.js", 42, {
          ignoreListed: true,
        }),
        6124: location(
          "/[metro-project]/node_modules/react-native/Libraries/LogBox/LogBox.js",
          222,
          {
            ignoreListed: true,
          }
        ),
        6020: location(
          "/[metro-project]/node_modules/react-native/Libraries/LogBox/LogBox.js",
          84,
          {
            ignoreListed: true,
          }
        ),
        190820: location("/[metro-project]/components/hello-wave.tsx", 4),
      })
    );

    expect(source).toEqual({ file: "components/hello-wave.tsx", line: 4 });
  });

  it("reports nothing when every frame is runtime code", () => {
    // A log raised entirely inside the runtime has no app frame to point at. Naming the
    // console polyfill would restate the original bug — the same file:line on every entry.
    const source = attributeLogSource(
      { callFrames: [frame(1160), frame(65240), frame(66205)] },
      mapperFor({
        1160: location("/[metro-project]/node_modules/@react-native/js-polyfills/console.js", 661, {
          ignoreListed: true,
        }),
        65240: location("/[metro-project]/node_modules/react-native/Libraries/Core/x.js", 42, {
          ignoreListed: true,
        }),
        66205: location("/[metro-project]/node_modules/react-native/Libraries/y.js", 167, {
          ignoreListed: true,
        }),
      })
    );

    expect(source).toBeNull();
  });

  it("falls back to node_modules detection when the map publishes no ignore list", () => {
    const source = attributeLogSource(
      { callFrames: [frame(1160), frame(190457)] },
      mapperFor({
        1160: location("/[metro-project]/node_modules/some-logger/index.js", 5, {
          ignoreListAvailable: false,
        }),
        190457: location("/[metro-project]/src/screen.tsx", 20, { ignoreListAvailable: false }),
      })
    );

    expect(source).toEqual({ file: "src/screen.tsx", line: 20 });
  });

  it("reports nothing when no ignore list exists and every frame is a dependency", () => {
    const source = attributeLogSource(
      { callFrames: [frame(1160)] },
      mapperFor({
        1160: location("/[metro-project]/node_modules/some-logger/index.js", 5, {
          ignoreListAvailable: false,
        }),
      })
    );

    expect(source).toBeNull();
  });

  it("steps over a frame that does not map instead of giving up", () => {
    const source = attributeLogSource(
      { callFrames: [frame(1160), frame(99999), frame(190457)] },
      mapperFor({
        1160: location("/[metro-project]/node_modules/@react-native/js-polyfills/console.js", 661, {
          ignoreListed: true,
        }),
        99999: null,
        190457: location("/[metro-project]/app/(tabs)/index.tsx", 11),
      })
    );

    expect(source).toEqual({ file: "app/(tabs)/index.tsx", line: 11 });
  });

  it("stops walking after a bounded number of frames", () => {
    const calls: number[] = [];
    const frames = Array.from({ length: 40 }, (_, i) => frame(i));
    const table: Record<number, OriginalLocation | null> = {};
    for (let i = 0; i < 40; i++) {
      table[i] = location(`/[metro-project]/node_modules/rt/${i}.js`, i, { ignoreListed: true });
    }
    // The only attributable frame sits well beyond the bound.
    table[30] = location("/[metro-project]/app/deep.tsx", 3);

    const source = attributeLogSource({ callFrames: frames }, mapperFor(table, { calls }));

    expect(source).toBeNull();
    expect(calls.length).toBeLessThan(40);
    expect(Math.max(...calls)).toBeLessThan(30);
  });

  describe("without a source map", () => {
    const noMaps: LogFrameMapper = {
      hasMaps: () => false,
      toOriginalPosition: () => {
        throw new Error("must not be consulted when no maps are registered");
      },
    };

    it("reads the frame's own script URL and reports a 1-based line", () => {
      const source = attributeLogSource(
        {
          callFrames: [
            {
              functionName: "run",
              scriptId: "1",
              url: "http://x/src/app.ts",
              lineNumber: 12,
              columnNumber: 3,
            },
          ],
        },
        noMaps
      );

      expect(source).toEqual({ file: "src/app.ts", line: 13 });
    });

    it("reports nothing for a bundle URL, whose line refers to generated output", () => {
      const source = attributeLogSource({ callFrames: [frame(1160)] }, noMaps);
      expect(source).toBeNull();
    });

    it("behaves the same when no mapper is supplied at all", () => {
      const source = attributeLogSource({
        callFrames: [
          {
            functionName: "run",
            scriptId: "1",
            url: "http://x/src/app.ts",
            lineNumber: 12,
            columnNumber: 3,
          },
        ],
      });

      expect(source).toEqual({ file: "src/app.ts", line: 13 });
    });

    it("falls back to the URL when a mapper is present but nothing resolves", () => {
      const source = attributeLogSource(
        {
          callFrames: [
            {
              functionName: "run",
              scriptId: "9",
              url: "http://x/src/app.ts",
              lineNumber: 12,
              columnNumber: 3,
            },
          ],
        },
        mapperFor({})
      );

      expect(source).toEqual({ file: "src/app.ts", line: 13 });
    });
  });

  describe("stacks with nothing to attribute", () => {
    it.each([
      ["no stack trace", undefined],
      ["no call frames", {}],
      ["empty call frames", { callFrames: [] }],
    ])("reports nothing for %s", (_label, stack) => {
      expect(attributeLogSource(stack as never, mapperFor({}))).toBeNull();
    });
  });
});

describe("normalizeMapSource", () => {
  it("strips Metro's project alias", () => {
    expect(normalizeMapSource("/[metro-project]/app/(tabs)/index.tsx")).toBe(
      "app/(tabs)/index.tsx"
    );
  });

  it("strips an absolute project root", () => {
    expect(normalizeMapSource("/Users/me/proj/app/index.tsx", "/Users/me/proj")).toBe(
      "app/index.tsx"
    );
  });

  it("leaves an absolute path intact when no project root matches", () => {
    // Stripping the leading slash here would produce a path that resolves nowhere.
    expect(normalizeMapSource("/Users/me/proj/app/index.tsx")).toBe("/Users/me/proj/app/index.tsx");
    expect(normalizeMapSource("/Users/me/proj/app/index.tsx", "")).toBe(
      "/Users/me/proj/app/index.tsx"
    );
  });

  it("keeps dependency paths recognisable", () => {
    expect(normalizeMapSource("/[metro-project]/node_modules/react-native/x.js")).toBe(
      "node_modules/react-native/x.js"
    );
  });
});

describe("cleanSourceUrl", () => {
  it("accepts source file URLs and rejects bundles and junk", () => {
    expect(cleanSourceUrl("http://localhost:8081/src/screens/Home.tsx?platform=ios")).toBe(
      "src/screens/Home.tsx"
    );
    expect(cleanSourceUrl(BUNDLE_URL)).toBeNull();
    expect(cleanSourceUrl("not a url")).toBeNull();
  });

  it("keeps a file:// path absolute so it still resolves", () => {
    expect(cleanSourceUrl("file:///Users/me/app/index.html")).toBe("/Users/me/app/index.html");
    expect(cleanSourceUrl("file:///Users/me/My%20App/index.html")).toBe(
      "/Users/me/My App/index.html"
    );
  });

  it("accepts an HTML document, whose frames report lines within it", () => {
    expect(cleanSourceUrl("http://localhost:3000/index.html")).toBe("index.html");
  });
});

describe("toFlatSourceToken", () => {
  it("renders an attributed source and the unknown placeholder", () => {
    expect(toFlatSourceToken({ file: "app/index.tsx", line: 11 })).toBe("app/index.tsx:11");
    expect(toFlatSourceToken(null)).toBe("-");
  });
});
