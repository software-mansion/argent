import { PostHog } from "posthog-node";

/** Hard-coded host so env-var overrides cannot redirect ingestion. */
export const POSTHOG_HOST = "https://eu.i.posthog.com";

/** Public write-only PostHog project token. */
export const POSTHOG_PROJECT_TOKEN = "phc_tkPxaBJ8WVr2KQAuu7FoN2nAcJ7MhVNsHSpUSuNC9HGV";

interface ResolvedConfig {
  key: string;
  /** True iff key is a real `phc_*` token (not "" / "phc_disabled"). */
  isUsable: boolean;
}

function readProjectToken(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const override = g.__ARGENT_POSTHOG_KEY_TEST;
  if (typeof override === "string") return override;
  return POSTHOG_PROJECT_TOKEN;
}

export function resolveConfig(): ResolvedConfig {
  const key = readProjectToken();

  // Sentinel guard for tests and emergency local builds.
  const isUsable = key !== "" && key !== "phc_disabled" && key.startsWith("phc_");
  return { key, isUsable };
}

let client: PostHog | null | undefined;

export function getClient(): PostHog | null {
  if (client !== undefined) return client;
  const config = resolveConfig();
  if (!config.isUsable) {
    client = null;
    return null;
  }

  const opts = {
    host: POSTHOG_HOST,
    disableGeoip: true,
    requestTimeout: 3000,
    flushAt: 20,
    flushInterval: 10_000,
  };

  try {
    client = new PostHog(config.key, opts);
  } catch {
    client = null;
    return null;
  }

  return client;
}

export function getConstructedClient(): PostHog | null {
  return client ?? null;
}

export function resetClient(): void {
  client = undefined;
}
