---
name: argent-qa-flows
description: Create repeatable QA regression E2E tests as Argent flows from natural-language test cases, tickets, or acceptance criteria. Use when the user asks to generate a QA test, automate a regression or E2E scenario, or preserve described actions and expected outcomes as a test. Orchestrates argent-create-flow, records the first walkthrough live, requires stable targets and explicit structural or visual checks, and completes only after two consecutive full passing runs. Do NOT use for a one-off interactive check that produces no saved test artifact (use argent-test-ui-flow), or for a replayable path with no acceptance criteria to prove (use argent-create-flow). iOS, Android, and Chromium only — not TV/Vega.
---

# Create a QA regression flow

Use `argent-create-flow` as the authoring engine. Load that skill now, then follow the references it marks required for the current task. It owns recorder/tool syntax, selectors, polish, platform exceptions, and repair. This skill adds only the QA contract and completion gates.

## Definition of done

For a TV/Vega target the touch directives this contract assumes do not exist — use `argent-tv-interact` and report the limitation.

A QA flow is complete only when every item holds:

1. **Self-contained, idempotent state:** the first non-echo step is `launch:`; setup establishes and hard-checks the required data baseline before the first scenario mutation; and repeated runs do not accumulate artifacts or require manual cleanup. Launch resets the process, not persisted app/account/backend data.
2. **Recorded live:** the first walkthrough — not a later reconstruction — produced every action and check, with the recorder started in `argent-create-flow`'s platform-specific order.
3. **Every requirement is executable proof:** each requested outcome maps to a hard `await:`, `assert:`, or reviewed `snapshot:` baseline comparison. A raw `screenshot` and an echo never count as unattended regression verdicts.
4. **Correct-screen proof:** every navigation is followed by an identity gate then a readiness gate, before the next action or negative check, per [`argent-create-flow` rule 4](../argent-create-flow/SKILL.md#non-negotiable-rules).
5. **Stable interaction:** targets follow `argent-create-flow`'s selector order and its **coordinate fallback gate**. QA is stricter about what the gate may clear: a coordinate is retained only for a genuinely unlabeled target, and failed selector candidates alone do not qualify.
6. **Fresh-service/warm consecutive passes:** the exact final YAML passes two uninterrupted full executions with the same runner and no edit or manual state recovery between them; the first mobile pass starts from freshly recycled Argent device services, and the second follows immediately.

## 1. Turn the request into a test contract

Before touching the app, write the test contract as a compact Markdown table in your reply, and restate it in the final report. Include:

- the app/platform and named start state;
- ordered user actions;
- one row per `verify`, `check`, `should`, persistence, or absence clause;
- the concrete stable executable evidence for each row;
- required data and side effects.

Choose evidence per outcome: use `await:`/`assert:` for semantic state, `snapshot:` for pixel rendering the tree cannot prove, and both for mixed requirements.

One behavioral scenario becomes one `qa-<area>-<behavior>` flow. Do not invent a material test value or weaken an ambiguous expected outcome to keep moving; choose the strongest UI-verifiable reading and report it, or ask when the choice changes test meaning.

Make repeated runs deterministic:

- Inspect the required baseline with read-only discovery before recording the scenario. If the account is already dirty, do not author the scenario from that state. Record a dedicated reset/seed flow first, or include safe normalization in the main flow's setup.
- Gate the normalized baseline early and hard. After launch, required non-mutating navigation, and any recorded reset/seed setup, add an echo that names the baseline and an `assert:` that proves it before the first scenario mutation. A destination-unique `await:` may serve as that hard gate only when it completely proves the named baseline. A dirty baseline must fail in setup, not many steps later on an unrelated check.
- Preferably restore the same data state at the end, so run N and run N+1 start from the same place.

Use `run:` for a dedicated reset/seed flow recorded under the same live-authoring rules — there is no other fixture mechanism. If safe cleanup is unspecified and would create/delete meaningful user data beyond the test, ask before recording.

### Worked example

Ticket: "On iOS in `com.acme.shop`, from signed-in Home, select the Dark theme in Settings and verify that Settings renders in dark mode, Dark is selected, and Light is not."

| Contract row              | Action                                              | Stable executable evidence                    | Data / side effect                                 |
| ------------------------- | --------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| App and named start state | Restart iOS app `com.acme.shop` from signed-in Home | `home-screen` visible, then `idle`            | Existing signed-in account                         |
| Reach Settings            | Tap `settings-tab`                                  | `settings-screen` visible, then `idle`        | None                                               |
| Normalized theme baseline | Inspect the settled Settings screen                 | `assert:` `theme-light-selected` is visible   | Fails in setup if an earlier run left Dark         |
| Select Dark               | Tap `theme-dark-option`                             | `theme-dark-selected` is visible              | Theme becomes Dark                                 |
| Exclude old state         | Inspect the settled Settings screen                 | `theme-light-selected` is hidden              | None                                               |
| Render dark appearance    | Compare the stable Settings screen                  | `settings-dark` matches its reviewed snapshot | Dark palette is visible across the screen          |
| Restore the baseline      | Tap `theme-light-option`                            | `theme-light-selected` is visible             | Theme back to Light, so run N+1 starts where N did |

Three rows carry more weight than they look. `home-screen` proves the named baseline because it exists only in the signed-in state. The Light-selected `assert:` does double duty: it fails in setup if a previous run left the app Dark, and it establishes `theme-light-selected` so the later `hidden` check is a verdict rather than an unfalsifiable pass. The closing restore is what keeps that baseline true — without it run 2 starts Dark, the tap changes nothing, and every check below it still passes, so the second consecutive pass proves nothing the first did.

## 2. Record under the QA contract

Follow `argent-create-flow`'s **Start in the correct order** and **Record the first walkthrough** sections for every recorder call and first-screen gate.

Record each structural contract verification as soon as its state appears. A `snapshot:` has no recorder form: inspect the stable visual state during the live walkthrough, then add the planned snapshot during polish as the documented non-mutating exception. If the walkthrough requires direct state-changing recovery, follow `argent-create-flow`'s wrong-turn procedure; recovered behavior is not proof unless the saved path still exercises it faithfully.

## 3. Make each verification discriminating

- **State change:** prove the new state and that the old state is absent when both could otherwise match.
- **Cancel/persistence:** cross the commit boundary — leave the screen, re-enter it, then verify the stored state.
- **Absence/removal:** first prove the correct containing screen/list loaded, then record the trio in order (`visible` → action → `hidden`). Nothing enforces the order for you: a `hidden` whose selector never matched records as a clean pass, flagged only by a note in the tool result. Prefer a positive replacement/empty state alongside. In a scrollable collection `hidden` proves only the loaded/visible tree: use seeded data that fixes the expected row position, a section count/empty state, or other collection-wide evidence instead of claiming global absence from one viewport.
- **Overlays over the next target:** a `visible` check on the target passes while a toast eats the tap — follow `argent-create-flow`'s [obscured-targets procedure](../argent-create-flow/references/reliability-and-recovery.md#obscured-targets-and-persistent-overlays) whenever a save/follow/delete raises one over the next target.
- **Repeated controls and section/list membership:** prefer a stable target id; otherwise bind the target/check to its row or card with flow-only [`within`](../argent-create-flow/references/flow-yaml.md#relational-scopes), whose containment is geometric. Use `text.in` on a stable container to prove rendered membership, not merely that the same name exists somewhere on screen.
- **Dynamic content:** assert app chrome or state the flow controls. Use a structural/regex check for unavoidable dynamic values, and disclose any accepted live-data dependency.
- **Visual appearance:** follow [Flow YAML: Snapshots](../argent-create-flow/references/flow-yaml.md#snapshots-and-standalone-runs). Snapshot only a correct, settled, deterministic state; use full-screen comparison for global changes and `cropOn` for a component.

Never put an acceptance check inside a `when:` block that may skip it. `when:` is only for optional setup or interstitial handling that reconverges to the same required path.

## 4. Finish, polish, and audit

Use `argent-create-flow` to finish and perform its full polish and blocking audit. Then compare the final YAML with the QA contract:

- map every contract row to an executed action or hard `await:`/`assert:`/`snapshot:` check;
- build a navigation table and include it in the report — one row per screen change, with the identity gate and the readiness gate named. A row missing either is a blocking defect, and the two are repaired differently: record a missing identity gate live on the restored screen, and add a missing readiness gate in YAML, because `await: { idle: true }` has no recorder form and is one of `argent-create-flow`'s three permitted polish insertions.

  | Action             | Expected destination | Identity gate                               | Readiness gate          |
  | ------------------ | -------------------- | ------------------------------------------- | ----------------------- |
  | Tap `settings-tab` | Settings             | `await: { visible: {id: settings-screen} }` | `await: { idle: true }` |

- confirm the setup and end state allow an immediate independent second run.

If the audit finds a missing action/check, record it live or re-record the affected path. Adding it only in YAML violates the contract and cannot enter proof.

## 5. Require two consecutive full passes

After the last edit and audit, set the pass streak to zero:

1. Choose the runner the test will actually use for both passes: `flow-execute` for a local-only flow, or `argent flow run <name> --platform <platform>` for CI. Switching runners resets the streak.
2. If the flow contains snapshots, seed, review, and freeze their baselines according to `argent-create-flow`. A baseline update does not count as a pass; never use one to dismiss an unexplained diff.
3. Make the first trial fresh, through the same Argent server as the chosen runner — two warm passes are correlated evidence, because a fixed timing margin can pass twice simply because environment speed did not change. Recycle the services with `stop-all-simulator-servers`, scoped to this flow's device so a shared tool-server's other agents keep theirs: `devices: [<this flow's device>]` through that MCP connection before two `flow-execute` passes, or `argent run stop-all-simulator-servers --devices <this flow's device>` from the same Argent install before two standalone passes. Never omit the scope — a bare call is the machine-wide sweep, and step 6 restarts this proof often enough to reap every other agent's devices repeatedly. Nothing needs reconnecting: the run establishes its own device and debugger connections, and the reset does not alter app/account data. For Chromium, let the runner boot the declared app path without an explicit `device` pin.
4. Run the entire flow from its own launch and in-flow setup, without baseline-update mode. Increment the streak only when the run reports `ok: true` and every required acceptance check — including each snapshot comparison — executed. A false `when:` may skip optional setup/interstitial steps only. A run with `errored > 0` neither passes nor fails: fix the environment and rerun, and do not report it as a regression.

   A passing step that carries a `warning` does not block the streak, but it must be resolved before you finish. `await: { idle: true }` raises [five different warnings](../argent-create-flow/references/flow-yaml.md#idle--readiness), so read which one it is before deciding what to do. Two of them say the screen was moving, and nothing in the report distinguishes intended motion from a load that never completed. The other three — the tree stayed empty, the settle saw the tree alone, too few reads — say the step ended with no evidence either way, so its screen was never proved still at all. In every case, inspect the screen, disclose the cause, and confirm the acceptance checks around it rest on stable elements rather than on stillness.

5. Run the same unchanged flow again immediately with the same runner. Do not manually reset app/account data between passing runs; the flow must make run 2 valid.
6. On any failure, YAML edit, re-recording, baseline update, or manual state-changing recovery, reset the streak to zero. Diagnose and repair through `argent-create-flow`, audit, and restart proof from step 1, including the fresh-service setup.
7. Finish only when the streak reaches two.

Record the runner and fresh-service setup used. If the intended runner is unavailable, report proof as blocked instead of substituting another runner.

If intended product behavior fails, keep the strong check and report the regression plus the unproven flow artifact — never weaken the test to reach a green run.

## 6. Report

Report:

- flow name, file path, platform, and the standalone command (`argent flow run <name> --platform <platform>`);
- the test-contract table, restated with its requirement-to-step/check mapping and any interpretation chosen;
- the navigation table from the audit;
- how the persistent baseline and end state are established;
- both consecutive passing run results, runner used, and fresh-service setup before pass 1, plus every step `warning` either run raised and what you found behind it;
- every snapshot name/scope, reviewed baseline status, and justified mismatch tolerance;
- coordinate/raw-gesture exceptions and accepted live-data dependencies;
- any remaining manual judgment or blocker.
