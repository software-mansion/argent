export interface CDPTarget {
  id: string;
  title: string;
  description: string;
  webSocketDebuggerUrl: string;
  deviceName?: string;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: {
      nativePageReloads?: boolean;
      prefersFuseboxFrontend?: boolean;
      nativeSourceCodeFetching?: boolean;
    };
  };
}

export interface MetroInfo {
  port: number;
  projectRoot: string;
  targets: CDPTarget[];
}

export async function discoverMetro(port: number): Promise<MetroInfo> {
  const statusRes = await fetch(`http://localhost:${port}/status`);
  const statusText = await statusRes.text();
  if (!statusText.includes("packager-status:running")) {
    throw new Error(`Metro at port ${port} is not running (got: ${statusText.slice(0, 100)})`);
  }

  // Stock Metro advertises the project root via this header; some forks (e.g.
  // Amazon's Metro for Vega/Fire TV) don't set it. The project root only affects
  // source-map path resolution — connect/evaluate/component-tree work without it
  // — so fall back to the process cwd (typically the project root) instead of
  // failing the whole debug session.
  const projectRoot = statusRes.headers.get("X-React-Native-Project-Root") || process.cwd();

  const listRes = await fetch(`http://localhost:${port}/json/list`);
  const targets = (await listRes.json()) as CDPTarget[];

  if (!targets?.length) {
    throw new Error(`Metro at port ${port} has no CDP targets — is a React Native app connected?`);
  }

  return { port, projectRoot, targets };
}
