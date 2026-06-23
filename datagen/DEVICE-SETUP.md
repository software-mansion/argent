# DEVICE-SETUP — real-device substrate for navigation datagen

Reusable notes for driving real apps through the Argent toolkit on the iOS simulator,
for generating navigation training data. Covers: the tool-server HTTP path, the simulator,
building Flutter / native-iOS / RN apps, and the **`describe` quality verdict per stack**.

Last verified: 2026-06-23 (iPhone 16 Pro Max, iOS 18.5, Xcode 16.4).

---

## 1. Tool-server HTTP API (how to drive the device)

We talk to the Argent tool-server over **HTTP directly** (bypass MCP stdio — calls are
synchronous, one `curl` away).

- **A global tool-server is already running and is what we use.** It is the installed
  `@swmansion/argent` package's `tool-server.cjs`, started by the user's normal Argent usage.
  Discovery file: `~/.argent/tool-server.json` →
  ```json
  { "port": <PORT>, "host": "127.0.0.1", "token": "<BEARER>", "pid": <PID>, "bundlePath": ".../dist/tool-server.cjs" }
  ```
  At verification time: port **52227**, pid 75742. **The port/token change** when the server
  restarts — ALWAYS read them from `~/.argent/tool-server.json`, never hard-code.
- **Keep-alive:** this server is kept alive by the user's own Argent session, not by us.
  If it dies, the global `argent` CLI respawns it on next use. (For an *origin/main* dev
  tool-server instead, see memory `e2e_dev_tool_server_setup` — needs a launchd LaunchAgent
  because the Claude Bash harness SIGTERMs spawned procs ~30s after the call returns; even
  `run_in_background`/`nohup` get reaped.)

### The `argent-call` helper
The documented skill helper `~/.claude/skills/argent-local-test/scripts/argent-call`
**does NOT exist on this machine** (the `argent-local-test` skill is not installed).
It is just a curl wrapper, so we use a local equivalent at `/tmp/argent-call.sh`:

```bash
cat > /tmp/argent-call.sh << 'SCRIPT'
#!/bin/bash
DJSON="$HOME/.argent/tool-server.json"
read -r PORT HOST TOKEN < <(python3 -c "import json;d=json.load(open('$DJSON'));print(d['port'],d.get('host','127.0.0.1'),d['token'])")
BASE="http://$HOST:$PORT"
sub="$1"; shift
case "$sub" in
  url) echo "$BASE" ;;
  list) curl -s -H "Authorization: Bearer $TOKEN" "$BASE/tools" | python3 -c "import sys,json;[print(t['name']) for t in json.load(sys.stdin)['tools']]" ;;
  schema) curl -s -H "Authorization: Bearer $TOKEN" "$BASE/tools" | python3 -c "import sys,json;d=json.load(sys.stdin);t=[x for x in d['tools'] if x['name']=='$1'];print(json.dumps(t[0].get('inputSchema',{}),indent=2) if t else 'not found')" ;;
  call)
    BF=$(mktemp); printf '%s' "${2:-{\}}" > "$BF"
    curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary @"$BF" "$BASE/tools/$1"
    rm -f "$BF" ;;
  raw) curl -s -H "Authorization: Bearer $TOKEN" "$BASE$1" ;;
esac
SCRIPT
chmod +x /tmp/argent-call.sh
```

Working invocations (the catalog has **69 tools**):
```bash
/tmp/argent-call.sh url                       # http://127.0.0.1:52227
/tmp/argent-call.sh list                      # tool names, one per line
/tmp/argent-call.sh schema describe           # JSONSchema of a tool's input
/tmp/argent-call.sh call list-devices '{}'
/tmp/argent-call.sh call launch-app  '{"udid":"<UDID>","bundleId":"<id>"}'
/tmp/argent-call.sh call describe    '{"udid":"<UDID>"}'
/tmp/argent-call.sh call screenshot  '{"udid":"<UDID>","includeImageInContext":false}'
/tmp/argent-call.sh call gesture-tap '{"udid":"<UDID>","x":0.5,"y":0.5}'
```

**Helper gotcha (cost time):** the JSON body must be passed via `--data-binary @file`, NOT
`-d "$json"` through a shell function — a naive `${2:-{}}` default or a stray trailing newline
corrupts the body and the server returns `SyntaxError: Unexpected non-whitespace character after JSON`.
The version above (`printf '%s'` into a mktemp file) is correct.

Response shape: `{ "data": { ... } }`. Screenshots return
`data.image.__argentArtifact` with a **`hostPath`** you can `Read` directly (PNG on disk under
`/var/folders/.../simserver-*/media/`).

---

## 2. Simulator

- **Standardize on iPhone 16 Pro Max — udid `6DBF83B4-F341-4F8D-B48D-CD8FF312CCFB`** (iOS 18.5).
  NOT the plain iPhone 16. It was already `Booted` at session start.
- Confirm: `/tmp/argent-call.sh call list-devices '{}'` → find `state:"Booted"`.
- Booting/installing via `xcrun simctl` is fine; **all interaction goes through the HTTP tools**.

### Tool gotchas
- **First screenshot after a cold sim-server start fails** with
  `Screenshot failed: no image to export` (MJPEG first-frame race). **Just retry once warm.**
- `describe` returns normalized `[0,1]` coords `(x, y, width, height)`. Tap centre =
  `(x + w/2, y + h/2)`. Feed straight to `gesture-tap` — same space.

---

## 3. Building & launching apps  (one heavy build at a time — 26 GB RAM)

External apps live in `/Users/ignacylatka/dev/mobile_apps_training_data/data/<owner>__<name>/`.
A build queue is at `/tmp/build_queue.txt`; a richer manifest with `buildability`/`blockers`
is at `datagen/apps-manifest.jsonl` (76 flutter, 48 ios-swift, 7 RN).

### Native iOS Swift  — EASY, RELIABLE ✅
Example: `austinzheng__swift-2048` (no CocoaPods, pure Swift).
```bash
cd .../austinzheng__swift-2048
xcodebuild -project swift-2048.xcodeproj -scheme swift-2048 -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=6DBF83B4-F341-4F8D-B48D-CD8FF312CCFB' \
  -derivedDataPath /tmp/swift2048-build \
  IPHONEOS_DEPLOYMENT_TARGET=12.0 \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
xcrun simctl install <UDID> /tmp/swift2048-build/Build/Products/Debug-iphonesimulator/swift-2048.app
/tmp/argent-call.sh call launch-app '{"udid":"<UDID>","bundleId":"f3nghuang.swift-2048"}'
```
- **bundleId:** `f3nghuang.swift-2048` (read from the built `.app/Info.plist` with PlistBuddy;
  the pbxproj uses `${PRODUCT_NAME:rfc1034identifier}`).
- **Gotcha:** old apps set `IPHONEOS_DEPLOYMENT_TARGET = 8.0` → Xcode 16 link error
  `SDK does not contain 'libarclite'`. **Fix: override `IPHONEOS_DEPLOYMENT_TARGET=12.0`** on
  the xcodebuild command line (no source edit). This is the standard fix for the whole iOS-Swift set.
- Apps with no checked-in `Podfile` (swift-2048, Unwrap, swift-radio-pro) just build with xcodebuild.
  Pod-based apps need `pod install` first (watch for old pod specs needing platform bumps).

### Flutter  — HARD: needs PER-APP Flutter SDK version matching ⚠️
**There is no single Flutter that builds these apps.** Each app pins a Flutter framework era and
breaks on any other SDK via framework API drift or transitive-dep incompatibility. Flutter was
**not installed** at all at session start — installed via `git clone -b <ver> ... && flutter --version`
into `~/dev/flutter-<ver>` (no sudo, no system change). Installed three side-by-side:
`~/dev/flutter` (3.44.3 / Dart 3.12), `~/dev/flutter-3.24` (3.24.5 / Dart 3.5.4),
`~/dev/flutter-3.7` (3.7.12 / Dart 2.19.6). Select per app with `export PATH=~/dev/flutter-<ver>/bin:$PATH`.

Build (once the matching SDK resolves):
```bash
export PATH="$HOME/dev/flutter-<ver>/bin:$PATH"
cd .../<flutter-app>
flutter pub get
flutter build ios --simulator --debug
xcrun simctl install <UDID> build/ios/iphonesimulator/Runner.app
/tmp/argent-call.sh call launch-app '{"udid":"<UDID>","bundleId":"<from Info.plist>"}'
```

**The app that BUILT & LAUNCHED: `kevmoo__slide_puzzle` under Flutter 3.7.12 (Dart 2.19).**
Recipe (note Runner.app + version-matched SDK):
```bash
export PATH="$HOME/dev/flutter-3.7/bin:$PATH"
cd .../kevmoo__slide_puzzle
flutter pub get && flutter build ios --simulator --debug
xcrun simctl install <UDID> build/ios/iphonesimulator/Runner.app
/tmp/argent-call.sh call launch-app '{"udid":"<UDID>","bundleId":"com.example.slidePuzzle"}'
```
One-time pubspec tweaks were needed ONLY when forcing it onto Dart 3 (relax `<3.0.0` ceiling +
bump dev-dep `stats` to `^2.1.0`); under the matching 3.7.12 the **stock pubspec builds unmodified**.

Observed failures (all version-mismatch, NOT app bugs):
- `jesusrp98__spacex-go`     — Dart `<3.0` pre-null-safety; won't resolve on any Dart-3 SDK.
- `scitbiz__flutter_pokedex` — `source_gen`/`analyzer`/`macros` vs `collection` conflict on 3.44 AND 3.24.
- `mllrr96__Neumorphic-Calculator` — resolves clean but pins **Flutter >=3.32.5**, yet `lucide_icons 0.257.0`
  fails to compile on Dart 3.12 (`IconData` is now a `final class`). Narrow window 3.32–3.40.
- `kevmoo__slide_puzzle` on 3.24 — overrides `DecorationImagePainter.paint`, whose signature changed
  in Flutter 3.24. **Builds fine on 3.7.12** (its Dart-2 era) — the version-match is the whole game.

**Implication for scaling (IMPORTANT):** `apps-manifest.jsonl` assumes one global `flutter` and rates
many Flutter apps "easy" — that is optimistic. Realistically each Flutter app needs its
contemporaneous Flutter SDK. Recommend: (a) use **`fvm`** (Flutter Version Management) to pin a
version per app dir, OR (b) record the required Flutter version in the manifest and pre-provision
2–4 SDK buckets (3.7 / 3.16 / 3.24 / 3.32). Build Flutter apps in version-sorted batches.

### React Native (7 apps)
Not exercised this session. Use Metro + the `debugger-component-tree` tool for element discovery
(AX on RN is thin). See memory `e2e_pokemon_fixture` for the live RN fixture pattern.

---

## 4. describe-quality verdict per stack  (THE KEY DELIVERABLE)

`describe` source on iOS = **`ax-service`** (accessibility tree, flat mode, normalized coords).

### Native iOS Swift — RICH ✅  (use as primary datagen substrate)
`austinzheng__swift-2048`, menu then game board:
- Menu: 2 elements — `AXButton "Start Game"` + its `AXStaticText`, both with coords.
- Game board after tapping Start: surfaces `AXStaticText "SCORE: 0"`, the `AXButton`, AND the live
  tile values `AXStaticText "2"` (x2) — even though tiles are **custom-drawn**, not UIKit controls.
- Labels are **meaningful and human-readable**, coords are tap-ready. describe matched the screenshot
  exactly. **Verdict: native iOS Swift is fully navigable via `describe` alone.**

### Flutter — RICH ✅  (VERIFIED — navigable via `describe`)
`kevmoo__slide_puzzle` (Material), `describe` via ax-service returned **23 AX elements**, all
meaningfully labeled and tap-ready:
- 15 puzzle tiles as `AXButton "14"`, `"4"`, `"9"`, … (live numeric labels, normalized coords).
- 3 difficulty tabs with semantics `AXGroup "SIMPLE\nTab 1 of 3"`, `"SEATTLE\nTab 2 of 3"`, `"PLASTER\nTab 3 of 3"`.
- Controls: `AXButton "Reset"`, `AXButton "Auto play" value="0"`.
- Status text: `AXStaticText "0 Moves"`, `AXStaticText "15 Tiles left"`.
describe matched the screenshot exactly (4×4 grid, one empty slot, tabs, counters).
**Verdict: a standard Material Flutter app IS fully navigable via `describe` alone** — Flutter's
widget `Semantics` surface through to iOS AX. Element count and label quality are on par with native iOS.
**Caveat (still expected, not yet hit):** icon-only / custom-painted widgets WITHOUT an explicit
`Semantics` wrapper will be AX-invisible (mirrors the known iOS "icon-only pressables are AX-invisible"
issue). Worth spot-checking on an icon-heavy Flutter app, but the Material baseline is solid.

### React Native — use `debugger-component-tree`, not `describe` (per project rules/memory).

---

## 5. Bottom line for scaling to dozens of apps
- **iOS-Swift (48 apps): best substrate.** Reliable xcodebuild + rich AX. One recurring fix:
  bump `IPHONEOS_DEPLOYMENT_TARGET` to 12.0 for ancient targets. Pod-based ones need `pod install`.
- **Flutter (76 apps): navigable via `describe` (verified), but building is the long pole.**
  describe quality on a Material Flutter app is RICH (23 labeled, tap-ready AX elements — see §4),
  so Flutter apps ARE usable as datagen substrate. The bottleneck is purely the BUILD: gated on
  per-app Flutter SDK version (framework API drift + transitive-dep breakage), not on Argent or AX.
  Provision multiple Flutter SDKs (fvm) and annotate the manifest with the required version before
  batching.
- **RN (7 apps):** lean on `debugger-component-tree` (Metro), not AX.
- **Tool-server + simulator are NOT the bottleneck** — both worked first try. The bottleneck is the
  heterogeneous Flutter build matrix.
