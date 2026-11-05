# HarmonyOS Targets

HarmonyOS targets exist only after `argent enable harmonyos`; with the flag off `list-devices` lists none and every `harmony-*` id is refused with `HarmonyOS support is off; turn it on with argent enable harmonyos`.

Everything in the related SKILL.md still applies; this page covers what differs.

## Ids and discovery

`list-devices` tags HarmonyOS entries `platform: "harmony"` and gives each a `kind`:

| `kind`     | id                        | state                   | What it is                                                                                                |
| ---------- | ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `device`   | `harmony-<connectKey>`    | `Connected` / `Offline` | A target connected over `hdc` (a phone on USB, or a booted emulator). The interaction tools drive this id |
| `emulator` | `harmony-emulator-<name>` | `running` / `stopped`   | A DevEco Studio instance. Only `boot-device` accepts it; never use it as an interaction target            |

- A running emulator appears under both kinds, as a running Android AVD appears in both `avds` and the device list.
- A plugged-in phone (`state: "Connected"`) is listed as ready alongside booted simulators. Pick a `harmony` entry only when the user asked for HarmonyOS, and pick the `kind: "device"` one.
- Every tool auto-dispatches on the id: `harmony-<connectKey>` is a HarmonyOS device, `harmony-emulator-<name>` is a boot target.

## Booting an emulator

A phone on `hdc` is ready as-is. Otherwise call `boot-device` with `harmonyInstance`: the instance `name` from the `kind: "emulator"` entry (e.g. `Phone_1`), or its `harmony-emulator-<name>` id. It hands the instance to DevEco Studio's Emulator manager, waits for it to register with `hdc`, and returns the `harmony-<connectKey>` id to drive. An instance that is already running is left alone unless you pass `force: true`. Read the `note` when one comes back: it says what the boot left unproven (no key and why, or a key not answering yet). Huawei serves emulator images only within mainland China, so a host outside it usually has no instance to start.

## What runs and what is refused

The device drives the tap / swipe / pinch / type / read loop with the same tool names as iOS and Android: `describe`, `screenshot`, `await-ui-element`, `await-screen-idle`, `gesture-tap`, `gesture-swipe`, `gesture-pinch`, `keyboard`, `button`, `launch-app`, `restart-app`, `reinstall-app`, `open-url`, `run-sequence`, `screenshot-diff`.

Refused as unsupported on harmony:

- `gesture-rotate` and `gesture-custom`: the device moves each contact along one straight line per call, so there is no arc and no long-press. There is no long-press tool on HarmonyOS.
- `gesture-drag` and `gesture-scroll` (Chromium-only), and `rotate`: the device has no orientation command.
- The app-scoped inspectors `native-describe-screen`, `native-view-at-point`, `native-user-interactable-view-at-point` and `debugger-component-tree`, which declare no harmony support and answer `Tool '<id>' is not supported on harmony device` before running. The rest of the debugger (`debugger-evaluate`, `debugger-log-registry`), `view-network-logs` and the profilers are refused too.
- `paste`, so a `{{secret:...}}` placeholder goes through `keyboard` only.
- Screen recording: HarmonyOS exposes no readable frame stream. Use `screenshot` for a still frame.

`gesture-pinch` sends both fingers' endpoints in one `uinput` call and the device interpolates the move; `durationMs` is wall-clock time, clamped to 1-15000ms. `gesture-swipe` is likewise one on-device call, and its `durationMs` sets speed, clamped to `uitest`'s 200-40000 px/s: a short slow swipe ends early, a long fast one runs late. `gesture-tap` with `clickCount: 2` is one double-tap gesture; 3 or more land as separate taps.

## Discovery

`describe` runs the device's own `uitest dumpLayout` (`source: "harmony-uitest"`) and returns it in the same DescribeNode shape as the other platforms. Each top-level child is a window carrying its bundle as `identifier`, so an app plus the status bar reads as two windows. `describe` and `screenshot` are the whole discovery surface, and when `describe` fails `screenshot` is the only fallback.

An empty tree comes with a `hint` that the layout dump contains no windows and the foreground app may still be starting. That is the expected read during app startup: call `describe` again rather than switching tools.

`screenshot` takes no `rotation`: `uitest screenCap` captures the display in its current orientation, so a `rotation` is refused with 400 and no image comes back. The same holds for a live capture in `screenshot-diff`. Rotate the device itself, or drop the parameter.

## Suspended panel

A suspended display still dumps its last-composited windows, which look like a live screen. `describe` then carries a `hint` that the panel is off, and the waits pass on that frame:

- `await-ui-element` with `success: true` and a `note`: the tree was read off a suspended panel. It is not clearance to act.
- `await-screen-idle` settles at once on the last frame; a `note` on `settled: true` says the screen is not live.

Taps land nowhere and input tools refuse against the panel until `button` with `power` wakes it.

## Keyboard keys

Only `enter` (alias `return`), `backspace` (alias `delete`), `space`, `arrow-left` and `arrow-right` exist; any other key is refused with 400 `KEYBOARD_KEY_UNSUPPORTED`. `delayMs` is ignored: `uitest uiInput text` types the text in one shot. Text cannot contain a newline or another control character; type the text, then send `key: "enter"`.

## Buttons

`button` accepts `home`, `back` and `power` only; any other button is rejected.

## App launch and open-url

- `launch-app` and `restart-app` take the bundle name as listed by `bm dump -a` (e.g. `com.huawei.hmos.calculator`). `activity` is ignored: the ability comes from the bundle's own `abilityInfos`. A launch fails if the app is not installed.
- `reinstall-app` takes one `.hap` file as `appPath` and the bundle name from its `module.json` as `bundleId`; a mismatch is refused before anything is uninstalled. A multi-module `.app` bundle is not accepted.
- `open-url` resolves any scheme through `aa start -U`, and every result carries a `note`: `aa` reports success whenever the system accepts the URI. A web URL can leave the screen unchanged, and `tel:` / `mailto:` can leave a "No options to open with" dialog over it. Confirm with `describe` or `screenshot` before treating the link as followed. It fails whenever `aa` refuses the URI, as it does a scheme nothing claims.

## Building and signing a HAP

Both blocks below use the default macOS install, the only layout verified; elsewhere point `C` and the Java path at the matching DevEco Studio directories. The build assumes the module `entry` and the product `default`, which the output path depends on. Build from the project root without the IDE:

```bash
C=/Applications/DevEco-Studio.app/Contents
export DEVECO_SDK_HOME=$C/sdk PATH=$C/tools/node/bin:$C/tools/ohpm/bin:$C/jbr/Contents/Home/bin:$PATH
ohpm install --all
rm -rf entry/build/default/outputs
node $C/tools/hvigor/bin/hvigorw.js --mode module -p module=entry@default -p product=default -p buildMode=debug assembleHap --no-daemon
```

With no `signingConfigs` in `build-profile.json5` this writes `entry/build/default/outputs/default/entry-default-unsigned.hap`. A `signingConfigs` naming key files this machine lacks (DevEco writes absolute paths under its author's `~/.ohos/config`) fails the build at `SignHap`, e.g. `Invalid storeFile value`, after that HAP is written; sign it below. Any other failed build leaves no HAP.

The emulator installs any HAP, including an unsigned one or one whose signature fails verification, so an emulator install proves nothing about signing. A phone refuses an unsigned HAP (`9568320 error: no signature file`). Sign it with a debug profile for the app's bundle name that lists the phone's UDID (`hdc -t <connectKey> shell bm get --udid`, last line; `hdc` is in `$C/sdk/default/openharmony/toolchains`). `L` below is `$C/sdk/default/openharmony/toolchains/lib`, set in the signing block.

**Test keys, no account.** `$L/OpenHarmony.p12` (password `123456`) is OpenHarmony's public test PKI; use it for development only. A HAP signed this way installs and launches on a HarmonyOS 6.0 phone.

1. Certificate chain `app-chain.cer`, leaf first: the `bundle-info.development-certificate` from `$L/UnsgnedDebugProfileTemplate.json`, then the `OpenHarmony Application CA` and `OpenHarmony Application Root CA` certificates from `$L/OpenHarmonyProfileDebug.pem`.
2. Profile `profile.json`: a copy of the template with your `bundle-info.bundle-name`, the phone's UDID in `debug-info.device-ids`, and a current `validity` window in epoch seconds (the template's expired in January 2024).
3. Sign the profile, then the HAP, from the project root with DevEco's Java:

```bash
C=/Applications/DevEco-Studio.app/Contents L=$C/sdk/default/openharmony/toolchains/lib
export PATH=$C/jbr/Contents/Home/bin:$PATH
rm -f app-signed.hap
java -jar $L/hap-sign-tool.jar sign-profile -mode localSign -signAlg SHA256withECDSA \
  -keystoreFile $L/OpenHarmony.p12 -keystorePwd 123456 -keyPwd 123456 \
  -keyAlias "openharmony application profile debug" -profileCertFile $L/OpenHarmonyProfileDebug.pem \
  -inFile profile.json -outFile profile.p7b &&
java -jar $L/hap-sign-tool.jar sign-app -mode localSign -signAlg SHA256withECDSA -signCode 1 \
  -keystoreFile $L/OpenHarmony.p12 -keystorePwd 123456 -keyPwd 123456 \
  -keyAlias "openharmony application release" -appCertFile app-chain.cer -profileFile profile.p7b \
  -inFile entry/build/default/outputs/default/entry-default-unsigned.hap -outFile app-signed.hap
```

**Real keys, Huawei ID.** These need the user's Huawei account; ask before using it.

- DevEco Studio: sign in, connect the phone, and tick _Automatically generate signature_ under File > Project Structure > Project > Signing Configs. Tick _Support HarmonyOS_ too if it is offered; without it the signature is an OpenHarmony one. It writes `signingConfigs` into `build-profile.json5`, and the build above then emits `entry-default-signed.hap`.
- AppGallery Connect: create a `.p12` and CSR (DevEco: Build > Generate Key and CSR), then request a debug certificate (`.cer`) from the CSR, register the phone's UDID and the app, and request a debug profile (`.p7b`) for that app, that certificate and the device. Run the signing block without `sign-profile`, giving `sign-app` your `.p12`, key alias, passwords, `.cer` and `.p7b`; AppGallery Connect has already signed the profile.

In the signing block's shell, `java -jar $L/hap-sign-tool.jar verify-app -inFile <hap> -outCertChain c.cer -outProfile p.p7b` checks the signature on the host, but not that the profile's bundle name matches the HAP's. A phone refuses that mismatch with `9568329 verify signature failed`, so only an install proves the phone accepts a HAP. Install it with `reinstall-app` (`appPath` the HAP's absolute path, `bundleId` its bundle name), then `launch-app` it. `reinstall-app` uninstalls first, so a HAP the phone refuses also costs the installed copy and its data; to keep them, install with `hdc -t <connectKey> install <hap>` instead, which leaves the installed copy on a refusal.

## E2E tests

The e2e runner (`e2e-execute`, skill `argent-create-e2e`) runs on HarmonyOS only when you name the device: `device: "harmony-<connectKey>"` (`--device` on the CLI). A HarmonyOS device is never auto-resolved, and `platform` / `--platform` does not accept `harmony`. HarmonyOS is not an authorable platform either: `when: { platform: harmony }` and a `harmony:` launch-map key are rejected when the YAML is parsed, so launch with a bare app id or `native:`.

The runner has no UI tree on HarmonyOS (`describe` reads the `uitest` layout dump, but no runner tree source exists), so no selector resolves:

- Every selector step errors with a reason containing `ui-tree matching is not supported on platform "harmony"`: a selector `tap:` / `swipe:` / `pinch:`, `type:` (selector-only), `scroll-to:`, `await:` / `assert:` and `when:` UI conditions, and `snapshot:` with `cropOn:`.
- `await: { idle: true }` errors immediately, with no polling, since no relaunch can restore a tree that does not exist. It names `wait:` as the replacement and skips the rest of the run.
- `long-press:` and `rotate:` are refused up front, with or without a selector: `uitest uiInput` sends one whole gesture per call with no hold duration, and `uinput -T -m`, the two-contact injection `pinch:` rides on, moves each contact along one straight line, never an arc.

What runs: a coordinate `tap:`, a selector-less `swipe:` and `pinch:`, `launch:`, `snapshot:` without `cropOn:`, `wait:`, `echo:`, `script:`, and raw `tool:` steps for the tools that support HarmonyOS. For anything that needs a selector, run the scenario as a live interact-screenshot-verify loop instead.
