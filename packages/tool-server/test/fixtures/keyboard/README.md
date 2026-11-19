# On-screen keyboard trees

Real trees with the software keyboard up, for `test/flows/flow-keyboard-keys.test.ts`.

## iOS simulator

The `ios-*.json` files are raw replies of the ax-service `tree` call, the input of
`adaptAxTree`. The app is `capture-app.swift` (bundle id `com.example.kbrank`), built
for the simulator with `swiftc` and installed with `simctl install`. It has:

- a `name` field with the return key "done" (id `Done`), and a full-width app "Done"
  button larger than that key, which hides itself and sets the status to "saved";
- an `amount` decimal-pad field with an accessory toolbar "Done". The decimal pad's
  delete key is "Delete", with no id;
- a `website` URL field with the return key "go" (id `Go`), above a label "Google";
- an app "Delete" button above the keyboard, and a tall one the keyboard covers.

The keyboard is the English (US) one, except in the `-pl` file. A new simulator may
start with the host's language, and argent's simulator-server sets the host's language
when it starts, so set English again after the first gesture. To switch, write `AppleKeyboards` (`en_US@sw=QWERTY;hw=Automatic`,
`emoji@sw=Emoji`) and `KeyboardLastUsed` in the simulator's global defaults, run
`launchctl kickstart -k user/foreground/com.apple.TextInput.kbd` in the simulator,
then relaunch the app.

| File                                            | Device, OS                      | Launch arguments | Screen                                      |
| ----------------------------------------------- | ------------------------------- | ---------------- | ------------------------------------------- |
| `ios-27-iphone-name.json`                       | iPhone 17, iOS 27.0             | none             | `name` focused                              |
| `ios-27-iphone-name-two-done.json`              | iPhone 17, iOS 27.0             | `-twoDone`       | `name` focused, a second, taller app "Done" |
| `ios-27-iphone-name-after-done.json`            | iPhone 17, iOS 27.0             | none             | `name` focused, after a tap on the app Done |
| `ios-27-iphone-decimal-pad-covered-delete.json` | iPhone 17, iOS 27.0             | `-coveredOnly`   | `amount` focused, only the covered "Delete" |
| `ios-27-iphone-url.json`                        | iPhone 17, iOS 27.0             | none             | `website` focused                           |
| `ios-27-iphone-edit-menu.json`                  | iPhone 17, iOS 27.0             | none             | `name` holds "Par", its edit menu is open   |
| `ios-27-iphone-no-keyboard.json`                | iPhone 17, iOS 27.0             | none             | no field focused                            |
| `ios-27-iphone-name-pl.json`                    | iPhone 17, iOS 27.0             | none             | `name` focused, Polish keyboard             |
| `ios-26.5-iphone-name.json`                     | iPhone 17, iOS 26.5             | none             | `name` focused                              |
| `ios-27-ipad-name.json`                         | iPad Pro 11-inch (M5), iOS 27.0 | none             | `name` focused: undo, redo and Paste bar    |
| `ios-27-ipad-emoji-search.json`                 | iPad Pro 11-inch (M5), iOS 27.0 | none             | the emoji keyboard's "Search Emoji" field   |

## Physical iPhone (XCUITest runner)

`ios-27-runner-snapshot-name.json` is the reply of the runner's `snapshot` command
with the `name` field focused: the runner with the keyboard mark, built for an
iPhone 17 simulator on iOS 27.0 (Xcode 27.2), same app and keyboard as above. The
simulator build needs the `volumeUp`/`volumeDown` cases in
`ArgentRunnerSession+Commands.swift` behind `#if !targetEnvironment(simulator)`.
Nodes of the keyboard's window carry `keyboard: true`.

### Check on a physical iPhone

The simulator capture above stands in for a device. To check a cabled iPhone, set
it up as the `argent-ios-device-setup` skill says, build this checkout
(`npm run build`, then `npm run build -w @swmansion/argent`), and save this e2e
test as `.argent/e2e/keyboard-device-check.yaml` in an empty directory:

```yaml
version: 2
steps:
  - launch: com.apple.Preferences
  # The Settings search field brings up the keyboard.
  - tap: { role: AXTextField }
  # A key is still a target: this waits for the keyboard and types a space.
  - tap: { id: space }
  # A condition does not see the keyboard, so both pass only with the mark.
  - assert: { hidden: { id: space } }
  - assert: { hidden: { id: shift } }
```

From that directory, run
`node <checkout>/packages/argent/dist/cli.js e2e run keyboard-device-check --device <udid>`.
The CLI reuses a tool-server that already runs, so first check with `server status`
that none runs, or that it is the one of this checkout. Both `assert` steps pass when
the runner marks the keyboard. A runner without the mark fails the first one with
"an element matching id="space" was still visible".

## Android

The `android-*.xml` files are the helper's full-hierarchy dumps
(`interactive-windows`, tree version 2) from a Pixel emulator on Android 16
(API 36), 1080x2400, with Gboard 17.8. Each window is a root that carries
`window-type`; the input method's window has type 2.

The stylus setting must be off, or Gboard shows a floating toolbar in place of the
keys: `adb shell settings put secure stylus_handwriting_enabled 0`, and
`settings delete secure stylus_handwriting_enabled` afterwards.

| File                              | Screen                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `android-36-settings-search.xml`  | Settings, search bar tapped, nothing typed: the app's "Back" button and Gboard's navigation-bar back key, both labelled "Back" |
| `android-36-settings-results.xml` | the same after typing, with result rows behind the keys                                                                        |
