/**
 * The platforms an AUTHOR can name in a flow file: launch-map keys and
 * `when: { platform }` guards.
 */
export const LAUNCH_PLATFORMS = ["ios", "android", "chromium", "vega"] as const;

/**
 * The platforms a RUN can be pointed at — flow-run's `platform` param and the
 * CLI's `argent flow run --platform`. `ios-remote` is selectable but deliberately
 * not writable: a flow says what it drives, not which machine hosts the
 * simulator, so `when:` and launch maps stay on {@link LAUNCH_PLATFORMS}.
 */
export const SELECTABLE_PLATFORMS = [...LAUNCH_PLATFORMS, "ios-remote"] as const;
export type SelectablePlatform = (typeof SELECTABLE_PLATFORMS)[number];
