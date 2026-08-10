# Reliability and recovery

Read this file when selector capture warns, a finished file contains coordinates/raw scrolling, a transition or overlay can swallow an action, the platform's flow tree source is unavailable (iOS native devtools, the Android helper, a Chromium CDP session, the Vega toolkit), or a replay fails.

- [Coordinate fallback gate](#coordinate-fallback-gate)
- [iOS selector recovery](#ios-selector-recovery)
- [Tree source recovery on Android, Chromium, and Vega](#tree-source-recovery-on-android-chromium-and-vega)
- [Strong transition gates](#strong-transition-gates)
- [Obscured targets and persistent overlays](#obscured-targets-and-persistent-overlays)
- [Diagnose a replay failure](#diagnose-a-replay-failure)
- [Correct the smallest justified unit](#correct-the-smallest-justified-unit)

## Coordinate fallback gate

Use this order for every element-targeting action, applying the [stable-selector definition](../SKILL.md#stable-selectors):

1. strict `{ id: ... }`;
2. narrow, stable `{ text: ... }` or accessibility label;
3. stable role only when it uniquely identifies the element;
4. `scroll-to` plus one of those selectors for an off-screen target;
5. raw coordinates only after completing this gate.

An element-seeking swipe follows the same rule: if its purpose is to reveal a target, replace it with `scroll-to`. Keep a coordinate swipe only when the gesture itself is the intended UI action — for example, testing or invoking a real swipe-to-dismiss interaction — and no selector-based directive expresses it.

### Run the gate on the warning, not at audit time

Work this gate the moment `flow-add-step` warns that it kept a raw point — and equally when it silently recorded a role-only selector, which warns about nothing — while the screen that produced it is still on the device:

1. On iOS, make an evidenced full-tree probe before keeping the point: query each plausible id/label with `native-find-views`; when there is no useful query term, call `native-full-hierarchy` with narrow `fields` and `maxDepth: 100`. Record the relevant match or no-match result with the exception evidence. `describe` and the leaf-only `native-describe-screen` are accessibility projections and are never sufficient evidence that no flow selector exists. A recorder warning only proves automatic derivation failed; it does not rule out a sibling or child label that can safely receive the tap.
2. On other platforms, inspect the deepest available app tree: `debugger-component-tree` for React Native, otherwise `describe`. On Android no tool exposes the runner's tree at all, so step 3 is the only way to confirm a candidate there. Prefer an id on iOS and Android even when trimmed discovery omits it; on Chromium the runner's tree is a [subset of `describe`](flow-yaml.md#the-runner-tree-is-not-the-discovery-tree), so an element absent there has no selector at all.
3. Verify candidates in a scratch fragment containing `assert: { visible: <candidate> }`, executed on the valid target screen. If one passes, replace the point. If it fails, inspect the exact reason and try a better id, label, target app, or container; do not assume a visible miss is depth truncation.
4. If no candidate resolves and you have the app's source, read it for the element's `testID` / `accessibilityIdentifier` / `resource-id` — the code is the one projection no discovery tool trims, and it names ids the others can drop. If the element has none, tell the user which element needs a stable test id and report that as the real fix; a kept coordinate is the workaround.

A tree-unavailable error makes the candidate run **void** — on iOS an error containing `native devtools is unavailable` or `No native-devtools-connected apps are available`, on Android a failure to reach the devtools helper, on Chromium an unreachable CDP session, on Vega a missing page source. It proves the tree was absent, not that the selector failed, and never authorizes coordinates — and it is the same reason the recorder quotes back in its `selector capture failed` warning, so read that warning before treating it as a verdict about the element.

Coordinates may remain only when the target is genuinely unlabeled (no id/text/label in available discovery) or all plausible labeled candidates failed against a working flow tree. Precede the kept point with an echo naming the target, and follow it with an `await:`/`assert:` on the **outcome** — the destination screen, the changed state, the element that disappeared. The target itself has no selector to check, so what makes the step falsifiable is proof that the tap landed, not proof that the target exists. Report the evidence. Anything the gate did not clear gets re-recorded against a selector, not annotated. A QA flow may keep such a step only for a genuinely unlabeled target, and every kept coordinate must appear in the report with its evidence; any other kept coordinate is a blocking defect.

## iOS selector recovery

The full iOS flow tree exists only for an app Argent launched with instrumentation.

1. If the app came from Metro/Expo, Xcode, its icon, or an earlier uninstrumented launch, call `restart-app`, restore the screen, and retry. `launch-app` does not terminate the app first: when the app is already running, the launch only foregrounds that existing, uninstrumented process. Only `restart-app` (terminate + relaunch) guarantees an instrumented launch.
2. Tap capture does **not** wait for that connection: it makes one tree read and turns any failure straight into the kept-coordinates warning. A recording-time `restart-app` returns before the devtools connection opens, so a missing-tree warning on the first tap after a restart can be transient. Re-record that tap once before escalating. Only a warning that survives the retry is evidence of a real fault.
3. Call `native-devtools-status` with the same explicit simulator UDID and bundle id. If `requiresRestart` is true, restart once and check again.
4. If the app is injectable but still disconnected, call `stop-all-simulator-servers` once, **scoped to `devices: [<this simulator's UDID>]`** — the UDID step 3 already has in hand. One tool-server serves every agent using this Argent install, so an unscoped call tears down their devices too. Then call `restart-app` and `native-devtools-status` again. This recreates the current Argent transport and devtools services; it does not change app/account data.
5. If it remains disconnected, report an Argent server/instrumentation environment blocker. Do not call the app non-injectable or replace selector actions with coordinates in a QA flow.

More than one booted simulator is not itself an injection fault: native services are keyed by UDID. Use the same explicit UDID throughout; when standalone flow device selection reports ambiguity, pass `--device <udid>`.

Android, Chromium, and Vega never inject anything, so none of this applies to them — their tree sources fail differently, see [Tree source recovery on Android, Chromium, and Vega](#tree-source-recovery-on-android-chromium-and-vega).

### Terminally non-injectable iOS apps

**Scope gate: this section applies only to `com.apple.*` system apps. A connection failure in any other app never authorizes this fallback.**

Apple system apps (`com.apple.*`) cannot load the instrumentation, and nothing in the launch path exempts them. A `launch:` step on iOS always waits for the devtools connection, so for one of these apps it spends that budget, fails, and every later step is skipped.

**Never give such a flow a `launch:` step.** Start it with a raw `tool: restart-app`, which performs the same terminate-and-relaunch without the readiness gate. Accept that the result is a **fragment**: its first non-echo step is not `launch:`, so the runner never classifies it as e2e. The rest of the injection-free form:

- raw `tool: await-ui-element` checks against the accessibility tree;
- point `tap:` / `long-press:` actions derived from `describe`, each named by an echo;
- point focus tap plus raw `tool: keyboard` with `delayMs: 500`;
- raw `gesture-swipe` calls with `settle: true` (momentum-free, so the scroll lands where the finger lifts and the following coordinate taps stay valid) because `scroll-to` needs the missing flow tree.

Disclose that the whole flow is injection-free. Do not pretend its coordinates are portable.

An injection-free flow is a valid generic flow but never a QA-contract-satisfying one: report it as an injection-free artifact plus the platform blocker, not as a completed QA test. Disclose it in the final report.

The same fragment fallback covers a normally injectable app that is broken in the environment: raw `tool: restart-app` in place of `launch:` still makes a self-resetting flow. Either way the flow cannot satisfy the `argent-qa-flows` e2e contract, which requires a leading `launch:`. Report the blocker rather than labeling that fallback a completed QA test.

## Tree source recovery on Android, Chromium, and Vega

No injection is involved, but each platform has one source the runner cannot do without. While it is down, selector directives fail and every recorded tap keeps its raw point — a void run, never a coordinates case. Restore the source, re-record the affected taps, and delete the points that outage produced.

| Platform | Symptom                                                          | Cause and fix                                                                                                      |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Android  | `launch:` reports it could not reach the Android devtools helper | The helper could not be installed or started — unlock the device, allow `adb install -t`, re-run                   |
| Chromium | a step reports no reachable CDP session                          | The Electron target died or was started without remote debugging — re-boot it with `boot-device`/`electronAppPath` |
| Vega     | `launch:` reports the toolkit served no page source              | The toolkit attaches at app launch — re-run to relaunch; the app must be built with automation support             |

**On Android, a healthy `describe` is not evidence that the flow tree is available.** `describe` falls back to a legacy `uiautomator dump` when the helper is missing; the flow tree refuses that fallback, because a trimmed tree silently changes what selectors match instead of failing. Discovery therefore looks perfect while every flow selector fails.

## Strong transition gates

Every navigation carries identity then readiness ([why](flow-yaml.md#prove-a-navigation-identity-then-readiness)). **Never prove a screen** with a shared header, a persistent tab bar, a source element, a positional id (`…-selector-1` encodes how many siblings exist), or a data-derived value (a counter, a count, a username, a timestamp).

### Leave a screen by a fixed destination, not by popping the stack

A back button, a swipe-back, and a post-save `goBack()` all pop **one** stack entry, so where they land depends on how many entries the run happened to push. A flow that reached the same screen twice has a different stack depth than the walkthrough did, and the identity gate after the back tap then fails on the wrong destination.

Prefer an action whose destination is fixed regardless of history: tapping the already-active bottom-tab pops to that tab's root, and a Home/Close affordance goes to a known screen.

Reach for back only when the back navigation _is_ the behavior under test. Gate it on identity like any other navigation, and expect the destination to depend on the path taken to get there.

## Obscured targets and persistent overlays

A selector tap resolves an element and dispatches at its coordinates; it does not prove that element is the topmost hit-test target. A toast, snackbar, banner, sheet, or other overlay can absorb the touch while the step reports success, producing a silent misfire that surfaces later.

- After a mutating action raises an overlay that intersects the next target, first establish its selector **while it is visible**, then dismiss it and record `await: { hidden: <overlay selector> }` before touching that region — the trio in order, so the absence check can actually fail. Do not rely on an auto-dismiss timer; automation or backgrounded rendering can pause it.
- Prefer an app-provided e2e build affordance that disables or shortens transient overlays. Otherwise record the real dismissal interaction.
- On iOS, use the `native-user-interactable-view-at-point` tool for live diagnosis of which view would receive a candidate touch. Android and Chromium have no hit-test tool, so there the recorded `visible` → dismiss → `hidden` trio is the only proof the overlay is gone.
- Keep a dismissal swipe only when the UI really supports swipe-to-dismiss. Treat it as the intended semantic action, not as element-seeking movement; put it through the coordinate fallback gate and hard-check that the overlay became hidden.

## Diagnose a replay failure

Classify the result before editing:

| Outcome              | Evidence                                                                                                     | Next step                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard error           | A step reports error/fail and later steps skip                                                               | Inspect that step and actual state                                                                                                                                                                                                 |
| Environment, not app | The reason says the check could not run — an unreadable tree, unconfirmed focus with no tree to read it from | Fix the environment and rerun; it is not a verdict about the app and never counts toward or against a pass streak                                                                                                                  |
| Silent misfire       | Run reports success but expected final state is wrong                                                        | Restore the screen where the state should have changed and record the missing gate live; do not add it in YAML                                                                                                                     |
| Partial divergence   | An intermediate screenshot/tree disagrees with its echo                                                      | Find the first divergent transition                                                                                                                                                                                                |
| Acceptance failure   | Navigation/actions passed but a requested check fails                                                        | Preserve the check; investigate app/data behavior                                                                                                                                                                                  |
| No clean settle      | A step passed carrying a `warning` from `await: { idle: true }`                                              | Read [which of the six warnings](flow-yaml.md#idle--readiness) it is — the screen moved, the wait ran out mid-hold, or the step got no evidence it settled — then look at that screen and gate the next action on a stable element |

Then:

1. Note the first failure/divergence index and message.
2. Call `screenshot` and `describe`; when deeper evidence is needed, call `native-find-views` / `native-describe-screen` (iOS only) or `debugger-component-tree` (React Native).
3. Compare actual state with the preceding echo and expected destination.
4. Classify the cause: wrong selector, wrong screen, missing element, timing/readiness, stale prerequisite/data, optional interstitial, or real product behavior.
5. State the diagnosis in one sentence before correcting anything.

## Correct the smallest justified unit

- **Parameter/selector error in one step:** edit the YAML, preferring a stable selector over a new coordinate.
- **Timing/readiness failure:** repair the transition gate, then audit every step of the same shape in the flow — especially taps after a launch, screen push, drawer/sheet open, or mutating action. A fixed delay at only the observed failure leaves the same race at the other sites.
- **Identity failure (a silent misfire, or arrival on the wrong screen):** run the same same-shape audit. Every navigation gated the same weak way has the same defect, whether or not it has surfaced yet.
- **One new/missing transition or two to three structural steps:** reset to entry state and re-record the working prefix and changed portion live.
- **Four or more broken steps, unclear state, or comparison/profiling flow:** fully re-record so every action is exercised consistently.

  Either re-record restarts under the same `name` + `project_root`, and `flow-start-recording` truncates that `.yaml` before you can read it — copy the working prefix out first.

- **Transient manual recovery:** useful for diagnosis only; it does not fix the flow and cannot count as a replay pass.

### A replacement gate must be strictly stronger

A gate that let a misfire through is not repaired by a longer timeout — that keeps the same unfalsifiable check and only waits longer for it. The replacement must add the missing leg:

| The gate that failed             | Not this         | This                                                                                                                    |
| -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Shared header / positional id    | Longer `timeout` | A destination-only root or control id                                                                                   |
| Next tap lost to a moving screen | `wait: 2000`     | Add `await: { idle: true }` after the identity gate                                                                     |
| Tap absorbed by a toast          | Retry the tap    | `await: { hidden: <overlay> }` before the tap                                                                           |
| `hidden` that never matched      | Longer `timeout` | Record the `visible` check first, then the `hidden` one                                                                 |
| Typed value wrong or truncated   | Retype it        | Assert the committed value after `type:`; a bare retype hides whether the field was covered, unfocused, or not an input |

State which leg you added before rerunning.

### The correction budget is a stop, not a guideline

After any correction, rerun the entire polished flow from its declared start. Count every correction cycle. **After two unsuccessful cycles, stop editing** and report the remaining failure with the recommended human decision. A flow that fails at a different index each run while its step count grows is accumulating gates around an unproven path: re-record the affected span live instead of patching.

Never weaken, remove, hide behind `when:`, or replace a requested check merely to make the run green. If the product behavior is wrong, retain the strong test and report it as an unproven regression artifact; the invoking skill decides whether that satisfies its task. QA does not call it complete until its two-pass gate succeeds.
