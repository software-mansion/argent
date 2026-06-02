import https from "node:https";

const REQUEST_TIMEOUT_MS = 10_000;

export interface VersionAt {
  version: string;
  publishedAt: string | null;
}

export interface RegistryInfo {
  latest: VersionAt;
  /** version → ISO 8601 publish time (also includes created/modified). */
  times: Record<string, string>;
}

/**
 * Fetch the full npm packument (not `/latest`) — only it carries the `time`
 * map the release-age gate needs. `url` is the packument URL, e.g.
 * `https://registry.npmjs.org/@swmansion/argent`. Returns null on any failure
 * (never throws — update checks must not crash the caller).
 */
export function fetchRegistryInfo(url: string): Promise<RegistryInfo | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (value: RegistryInfo | null) => {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        safeResolve(null);
        return;
      }

      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(body) as {
            "dist-tags"?: { latest?: string };
            "time"?: Record<string, string>;
          };
          const latestVersion = json["dist-tags"]?.latest;
          if (!latestVersion) {
            safeResolve(null);
            return;
          }
          const times = json.time ?? {};
          safeResolve({
            latest: { version: latestVersion, publishedAt: times[latestVersion] ?? null },
            times,
          });
        } catch {
          safeResolve(null);
        }
      });
      res.on("error", () => safeResolve(null));
    });

    req.on("error", () => safeResolve(null));
    req.on("timeout", () => {
      req.destroy();
      safeResolve(null);
    });
  });
}
