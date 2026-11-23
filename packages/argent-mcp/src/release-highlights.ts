/**
 * The 3 to 5 changes of each stable release that users notice most, as short
 * sentences. The agent relays them once after an update (whats-new.ts). Add the
 * entry for a release in its version bump PR.
 */
export const RELEASE_HIGHLIGHTS: Readonly<Record<string, readonly string[]>> = {
  "0.34.0": [
    "Profile Mac apps with the native profiler, and react-native-macos apps with the React profiler.",
    "e2e script steps run TypeScript (.mts, .ts) and .js files.",
    "`argent link` transfers app bundles faster with zstd compression.",
    "`argent e2e list --json` prints the test list as JSON.",
    "Argent now needs Node.js 22.18 or later.",
  ],
};
