/**
 * Arg names that mean "the device to act on". Stripped from every recorded step
 * and re-injected with the resolved run device, so a name here must mean a
 * device id on EVERY tool that declares one — the strip is schema-blind.
 * `device` is `flow-execute`'s own, so a nested flow inherits the run device
 * instead of pinning the one it was recorded on (#607).
 *
 * `platform` is deliberately absent: it is not device-specific on every tool
 * (`react-profiler-analyze` declares its own, which a blind strip would
 * retarget), and it is read only when no device was given, so binding it would
 * change nothing.
 */
export const DEVICE_BIND_KEYS = ["udid", "device_id", "device"] as const;

/**
 * Args keys holding a LIST of device ids. Same treatment as
 * {@link DEVICE_BIND_KEYS}, but rebound to `[deviceId]`, since a run resolves
 * exactly one device and a flow that named several would be naming the
 * recording host's.
 *
 * `stop-all-simulator-servers`' `devices` is the only such key, and it is a
 * scope rather than a target: a recording of the UNSCOPED sweep rebinds to the
 * run device (binding can only narrow, and the replay must not reap devices
 * another agent is mid-session on), while a recorded scope is the flow's own
 * statement of what to reap and is overridden only by an explicit `device` —
 * see `bindDeviceArgs` in `tools/flows/flow-device.ts`, where the two cases part.
 *
 * The server policy (`server-policy.ts`) reads the same two lists to decide
 * which devices an invocation names.
 */
export const DEVICE_BIND_LIST_KEYS = ["devices"] as const;

/**
 * Arg names that name something to LAUNCH (an AVD, a Vega image, an Electron
 * app) rather than an existing device id. `boot-device` reads them; the device
 * they become has no id until the boot finishes, so a server policy that pins
 * device ids refuses them.
 */
export const DEVICE_LAUNCH_TARGET_KEYS = ["avdName", "vvdImage", "electronAppPath"] as const;
