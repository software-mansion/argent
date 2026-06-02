/**
 * Pure helpers for the React DevTools backend self-bootstrap path.
 *
 * Kept separate from the tool files so they can be unit-tested without CDP /
 * vitest mocking. The bootstrap script itself lives in `scripts.ts` as
 * `BOOTSTRAP_DEVTOOLS_BACKEND_SCRIPT`; this module owns the shape of the
 * result it returns and the mapping from each failure reason to an
 * agent-facing error message.
 */

export type BootstrapReason =
  | "already-attached"
  | "bootstrapped"
  | "no-hook"
  | "no-renderers"
  | "no-metro-modules"
  | "no-rdt-module"
  | "unsupported-rdt-version"
  | "metro-scan-error"
  | "bootstrap-threw"
  | "bootstrap-no-effect";

export type BootstrapResult = {
  ok: boolean;
  reason: BootstrapReason;
  renderersCount?: number;
  rendererInterfacesCount?: number;
  message?: string;
};

/**
 * Translate a bootstrap failure into an agent-facing error message.
 *
 * Each message describes what went wrong, a plausible cause, and what the
 * agent should ask the user / do next — in one short sentence per part, with
 * no internal identifiers or jargon.
 */
export function bootstrapFailureMessage(bootstrap: BootstrapResult): string {
  switch (bootstrap.reason) {
    case "no-hook":
    case "no-rdt-module":
      return "React DevTools is not available in this app. This usually means the app is a production build. Ask the user to run a development build of the app, then retry.";
    case "no-renderers":
      return "React has not rendered yet, so there is nothing to profile. Ask the user to wait until the app shows React content (or navigate to a screen with React content), then retry.";
    case "no-metro-modules":
      return "Could not attach the React DevTools backend: the JS runtime does not expose a Metro module registry. This runtime is not a standard Metro-bundled React Native app and the React profiler cannot proceed. Inform the user that React profiling is only supported on standard Metro / React Native bundles.";
    case "unsupported-rdt-version":
      return "This app is running React Native older than 0.74, which the React profiler does not support. Ask the user to upgrade React Native to 0.74 or newer to use this tool.";
    default: {
      const detail = bootstrap.message ? ` (runtime error: ${bootstrap.message})` : "";
      return `Could not attach the React DevTools backend${detail}. Ask the user to fully reload the JS bundle and retry. If the error persists, the runtime may not be supported by the React profiler.`;
    }
  }
}
