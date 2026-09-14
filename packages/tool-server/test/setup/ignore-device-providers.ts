/**
 * Device-provider discovery reads `~/.argent/providers/`, which is
 * machine-global and describes whatever is running on the developer's machine
 * right now: a live provider publishes its real booted devices there. Any test
 * that touches list-devices or resolves a device would then see a device its
 * fixtures never created, so it passes in CI and fails on the machine of
 * whoever is actually using a provider.
 *
 * Opt back in by deleting this variable (it outranks
 * `ARGENT_DEVICE_PROVIDERS`) and pointing `ARGENT_DEVICE_PROVIDERS` at a
 * fixture, as the external-device tests do.
 */
process.env.ARGENT_DISABLE_DEVICE_PROVIDERS = "1";
