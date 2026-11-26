import os from "node:os";
import path from "node:path";

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

// boot-device mirrors the read-only emulators it boots to
// `~/.argent/android-read-only-boots.json`, which is machine-global in the same
// way. A boot test reading it would see records its fake world never made, and
// a read-only boot test would write its fake pids into it. So each test file
// gets a path of its own under the temp directory.
process.env.ARGENT_ANDROID_READ_ONLY_BOOTS_FILE = path.join(
  os.tmpdir(),
  `argent-android-read-only-boots-${process.pid}-${Math.random().toString(36).slice(2)}.json`
);
