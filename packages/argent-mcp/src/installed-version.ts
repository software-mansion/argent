import pkg from "../package.json" with { type: "json" };

/** esbuild bundles this version alongside the release highlights. */
export function getInstalledVersion(): string {
  return pkg.version;
}
