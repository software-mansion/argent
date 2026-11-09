# HarmonyOS Targets

HarmonyOS targets exist only after `argent enable harmonyos`; with the flag off `list-devices` lists none and every `harmony-*` id is refused.

Everything in the related SKILL.md still applies. The HarmonyOS specifics of each tool (key and button sets, `durationMs` clamping, `rotation` refused, the suspended-panel `hint`/`note`, `open-url`'s `aa start -U` note) are in that tool's description. This page covers what spans tools.

## Ids and booting

- Drive the `kind: "device"` entry (`harmony-<connectKey>`). A `kind: "emulator"` entry (`harmony-emulator-<name>`) is only a `boot-device` target; `boot-device` returns the `harmony-<connectKey>` id to drive.
- A plugged-in phone (`state: "Connected"`) is listed as ready alongside booted simulators. Pick a `harmony` entry only when the user asked for HarmonyOS.

## What runs and what is refused

These run with the same tool names as on iOS and Android: `describe`, `screenshot`, `await-ui-element`, `await-screen-idle`, `gesture-tap`, `gesture-swipe`, `gesture-pinch`, `keyboard`, `button`, `launch-app`, `restart-app`, `reinstall-app`, `open-url`, `run-sequence`, `screenshot-diff`.

Refused as unsupported on harmony:

- `gesture-rotate` and `gesture-custom`: the device moves each contact along one straight line per call, so there is no arc and no long-press. There is no long-press tool on HarmonyOS.
- `gesture-drag` and `gesture-scroll` (Chromium-only), and `rotate`: the device has no orientation command.
- `native-describe-screen`, `native-view-at-point`, `native-user-interactable-view-at-point`, `debugger-component-tree`, the rest of the debugger (`debugger-evaluate`, `debugger-log-registry`), `view-network-logs` and the profilers.
- `paste`, so a `{{secret:...}}` placeholder goes through `keyboard` only.
- Screen recording: HarmonyOS exposes no readable frame stream. Use `screenshot` for a still frame.

So `describe` and `screenshot` are the whole discovery surface; when `describe` fails, `screenshot` is the only fallback. An empty tree during app startup is expected: call `describe` again rather than switching tools.

## Gotchas

- A suspended panel still dumps its last frame, so `await-ui-element` can succeed and `await-screen-idle` can settle on it (each with a `note`). That is not clearance to act: wake the panel with `button` `power` first.
- Text cannot contain a newline or another control character: type the text, then send `key: "enter"`.
- `reinstall-app` takes one `.hap` file; a multi-module `.app` bundle is not accepted.

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
- `long-press:` and `rotate:` are refused up front, with or without a selector.

What runs: a coordinate `tap:`, a selector-less `swipe:` and `pinch:`, `launch:`, `snapshot:` without `cropOn:`, `wait:`, `echo:`, `script:`, and raw `tool:` steps for the tools that support HarmonyOS. For anything that needs a selector, run the scenario as a live interact-screenshot-verify loop instead.
