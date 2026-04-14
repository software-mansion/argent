import { SourceMapConsumer } from "source-map-js";

export interface GeneratedPosition {
  scriptUrl: string;
  scriptId: string;
  line1Based: number;
  column0Based: number;
}

interface RegisteredMap {
  scriptUrl: string;
  scriptId: string;
  consumer: SourceMapConsumer;
  sources: string[];
}

export class SourceMapsRegistry {
  private maps: RegisteredMap[] = [];
  private pendingRegistrations: Promise<void>[] = [];
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Begin fetching and registering a source map from a Debugger.scriptParsed event.
   * Returns immediately; use `waitForPending()` to block until all maps are loaded.
   */
  registerFromScriptParsed(
    scriptUrl: string,
    scriptId: string,
    sourceMapURL: string | undefined
  ): void {
    if (!sourceMapURL) return;
    const p = this.doRegister(scriptUrl, scriptId, sourceMapURL);
    this.pendingRegistrations.push(p);
  }

  async waitForPending(): Promise<void> {
    await Promise.allSettled(this.pendingRegistrations);
    this.pendingRegistrations = [];
  }

  /**
   * Resolve an original source file + line to its generated position in the bundle.
   *
   * `filePath` can be:
   *   - relative to project root, e.g. "App.tsx" or "src/components/Foo.tsx"
   *   - absolute, e.g. "/Users/.../App.tsx"
   *   - aliased, e.g. "/[metro-project]/App.tsx"
   */
  toGeneratedPosition(
    filePath: string,
    line1Based: number,
    column0Based: number = 0
  ): GeneratedPosition | null {
    const candidates = this.buildSourceCandidates(filePath);

    for (const map of this.maps) {
      for (const candidate of candidates) {
        if (!map.sources.some((s) => s === candidate)) continue;

        try {
          const pos = map.consumer.generatedPositionFor({
            source: candidate,
            line: line1Based,
            column: column0Based,
            bias: SourceMapConsumer.LEAST_UPPER_BOUND,
          });
          if (pos.line !== null) {
            return {
              scriptUrl: map.scriptUrl,
              scriptId: map.scriptId,
              line1Based: pos.line,
              column0Based: pos.column ?? 0,
            };
          }
        } catch {
          // try next candidate
        }
      }
    }

    return null;
  }

  /**
   * Find which source map source path matches the given file path.
   * Returns the matched source string or null.
   */
  findMatchingSource(filePath: string): string | null {
    const candidates = this.buildSourceCandidates(filePath);
    for (const map of this.maps) {
      for (const candidate of candidates) {
        if (map.sources.includes(candidate)) return candidate;
      }
    }
    return null;
  }

  private buildSourceCandidates(filePath: string): string[] {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const candidates: string[] = [];

    // If already aliased or absolute, try as-is first
    if (normalized.startsWith("/")) {
      candidates.push(normalized);
    }

    // Aliased: /[metro-project]/path
    candidates.push(`/[metro-project]/${normalized}`);

    // Absolute: projectRoot/path
    if (this.projectRoot) {
      candidates.push(`${this.projectRoot}/${normalized}`);
    }

    // Try suffix matching as last resort: find any source ending with /filePath
    const suffix = normalized.startsWith("/") ? normalized : `/${normalized}`;
    for (const map of this.maps) {
      for (const src of map.sources) {
        if (src.endsWith(suffix) && !candidates.includes(src)) {
          candidates.push(src);
        }
      }
    }

    return candidates;
  }

  private async doRegister(
    scriptUrl: string,
    scriptId: string,
    sourceMapURL: string
  ): Promise<void> {
    try {
      let rawData: unknown;

      if (sourceMapURL.startsWith("data:")) {
        const base64Part = sourceMapURL.split(",")[1];
        if (!base64Part) return;
        const decoded = Buffer.from(base64Part, "base64").toString("utf-8");
        rawData = JSON.parse(decoded);
      } else {
        const res = await fetch(sourceMapURL);
        if (!res.ok) return;
        rawData = await res.json();
      }

      const consumer = new SourceMapConsumer(rawData as any);
      const consumerSources = (consumer as any).sources;
      const rawSources = (rawData as any)?.sources;
      const sources: string[] = Array.isArray(consumerSources)
        ? Array.from(consumerSources)
        : Array.isArray(rawSources)
          ? rawSources.slice()
          : [];

      this.maps.push({ scriptUrl, scriptId, consumer, sources });
    } catch {
      // Failed to fetch or parse source map — silently skip
    }
  }
}
