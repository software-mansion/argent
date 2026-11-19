import * as os from "node:os";

/**
 * Which `Origin` header a Metro debugger WebSocket upgrade carries.
 *
 * Two checks stand in the way, and they disagree:
 *
 * - React Native's inspector proxy refuses the upgrade (401) unless the Origin
 *   equals its server URL or names a loopback host (`localhost`, `127.0.0.1`,
 *   `0.0.0.0`, `[::]`).
 * - Expo's dev server lets that upgrade complete, then terminates the socket
 *   unless the Origin's host equals its own server URL's host exactly. That URL
 *   is `http://127.0.0.1:<port>`, except when `REACT_NATIVE_PACKAGER_HOSTNAME`
 *   names another host, which takes its place.
 *
 * So no single Origin satisfies every Metro. `127.0.0.1` covers bare React
 * Native and Expo's default. The rest of the list covers an Expo whose server
 * URL was moved to another host and whose manifest did not name it (see
 * {@linkcode expoManifestOrigin}), which can only be found by trying.
 */
export function metroOriginCandidates(wsUrl: string): string[] {
  const { protocol, host, port } = new URL(wsUrl);
  const scheme = protocol === "wss:" ? "https://" : "http://";
  const at = (hostname: string) => `${scheme}${bracketed(hostname)}${port ? `:${port}` : ""}`;

  const candidates = [
    scheme + host.replace("localhost", "127.0.0.1"),
    at("localhost"),
    process.env.REACT_NATIVE_PACKAGER_HOSTNAME?.trim() || undefined,
    ...lanAddresses(),
    os.hostname(),
  ].map((candidate) => (candidate && !candidate.includes("://") ? at(candidate) : candidate));

  return [...new Set(candidates.filter((c): c is string => !!c))];
}

/**
 * The Origin an Expo dev server expects, read from the host of the bundle URL
 * in its manifest. Expo builds both from the same hostname:
 * `REACT_NATIVE_PACKAGER_HOSTNAME` when it is set, else `127.0.0.1` for a
 * request to a loopback host. Asking costs one HTTP request, where a wrong
 * guess costs an upgrade that evicts the debugger attached to the page.
 *
 * `undefined` when the server is not Expo, or answers with anything else.
 */
export async function expoManifestOrigin(wsUrl: string): Promise<string | undefined> {
  const { protocol, host } = new URL(wsUrl);
  const httpUrl = `${protocol === "wss:" ? "https:" : "http:"}//${host}/`;

  try {
    const response = await fetch(httpUrl, {
      headers: { "expo-platform": "ios", "accept": "application/expo+json,application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;

    const manifest = (await response.json()) as { launchAsset?: { url?: unknown } };
    const bundleUrl = manifest.launchAsset?.url;
    return typeof bundleUrl === "string" ? new URL(bundleUrl).origin : undefined;
  } catch {
    return undefined;
  }
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && !address.internal && address.family === "IPv4")
    .map((address) => address!.address);
}

function bracketed(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}
