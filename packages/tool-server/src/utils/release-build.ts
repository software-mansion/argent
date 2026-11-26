declare const ARGENT_RELEASE_BUILD: boolean | undefined;

export function isReleaseBuild(): boolean {
  return typeof ARGENT_RELEASE_BUILD === "boolean" && ARGENT_RELEASE_BUILD;
}
