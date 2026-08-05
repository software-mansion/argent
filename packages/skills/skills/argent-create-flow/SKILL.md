---
name: argent-create-flow
description: Create, record, edit, replay, or repair reusable Argent flow YAML files for device interaction. Use when the user asks to create or record a flow, script a repeatable device path, replay the same interaction, preserve a non-trivial path for profiling or A/B comparison, or invoke the authoring engine for argent-qa-flows. Also use proactively before repeating a path of three or more interactions. Do NOT use for a one-off interactive check (use argent-test-ui-flow), a saved QA/regression test driven by acceptance criteria (use argent-qa-flows), or a screen video or bug-reproduction clip (use argent-screen-recording).
---

# Create an Argent flow

An Argent flow is a replayable sequence in `.argent/flows/<name>.yaml`.

**If the request is a QA test case, ticket, or acceptance criteria to keep as a regression test, load `argent-qa-flows` first** — it owns the QA contract (self-contained state, discriminating checks, and two consecutive passes) and uses this skill as its engine.

## Read the relevant reference

- **Required before creating or changing a flow:** read [Live authoring](references/live-authoring.md) completely for the recorder workflow, polish pass, and final audit.
- **When writing or reviewing YAML by hand:** [Flow YAML](references/flow-yaml.md) — flow types, directives, conditions, composition, and runner syntax. For Vega, read its [Composition and platform limits](references/flow-yaml.md#composition-and-platform-limits) before recording remote/keyboard tools.
- **On a capture warning or a replay failure:** [Reliability and recovery](references/reliability-and-recovery.md) — coordinates or raw gestures appear, a transition is mistimed, an overlay may obstruct a target, the target is `com.apple.*`, an iOS app was not Argent-launched, or a platform's tree source is unavailable.

## Non-negotiable rules

1. **Record the path live.** The first walkthrough _is_ the recording; never rehearse a path and reconstruct it afterward. [Live authoring](references/live-authoring.md) has the per-platform start order and the discover → echo → `flow-add-step` → inspect cycle.
2. **Record each check when its state appears** — immediately after the transition or outcome it proves, before the next action. A check is recorded live as an `await-ui-element` call, which polish converts into the `await:`/`assert:` directive; an echo or raw `screenshot` is diagnostic context, not an executable verdict. Record absence as a trio in order — `visible` on the selector, the action that removes it, then `hidden` on the same selector; a `hidden` whose selector was never established cannot fail, so it proves nothing.
3. **Target semantics, not screen positions.** Prefer strict `{ id: ... }`, then a stable `{ text: ... }` or accessibility label; `scroll-to` for an off-screen target. The recorder converts a `gesture-tap` to a selector whenever it can and **warns when it had to keep the raw point** — stop on that warning and fix the target while the screen is still in front of you, rather than at audit time. Keep a coordinate only after the **coordinate fallback gate** in [Reliability and recovery](references/reliability-and-recovery.md#coordinate-fallback-gate), and report each one.
4. **After every screen change, prove identity, then readiness** — `await:` on an element that exists _only_ on the destination (never a shared tab bar, a source-screen element, or a positional id), then `await: { idle: true }`. Neither implies the other and a successful tap proves neither. They also arrive by different routes: identity is recorded live, readiness is a polish insertion (rule 5). [Live authoring](references/live-authoring.md#record-identity-then-readiness-after-every-navigation) has the procedure; [Flow YAML](references/flow-yaml.md#prove-a-navigation-identity-then-readiness) has why both are needed.
5. **Polish only what ran.** Rewriting a recorded raw step into an equivalent directive is allowed — a recorded `await-ui-element` becomes `await:`/`assert:`, a focus tap plus `tool: keyboard` becomes `type:`. Everything else must come from a recorded step; return to the live workflow to execute any missing **action** through the recorder.

   Exactly three unrecorded insertions are allowed, each only where you saw the condition live: `snapshot:` for an inherently pixel-level requirement, `await: { idle: true }`, and the Chromium packaging `launch:`. None of the three has a recorder form — see [Live authoring](references/live-authoring.md#finish-and-polish).

6. **Replay the finished file end to end.** A flow is not done because its steps worked separately. `argent-qa-flows` adds the stronger requirement of two consecutive full passes.

### Stable selectors

A selector is **stable** when its value is fixed by the app's code, not by data, locale, time, count, or position — it would survive a content refresh, a different account, and a re-order. IDs such as `save-button`, `settings-screen`, and `logout-action` are stable; `3 unread`, `Today`, `Item 4`, a username, or any data-derived number are not. Treat visible text as stable only when the app's code keeps it identical across every locale and environment the flow supports.

### Flow-only selector scopes

During YAML polish, use the frame-based `within`, `after`, and `next` scopes to disambiguate repeated elements. Read [Flow YAML: Relational scopes](references/flow-yaml.md#relational-scopes) for syntax, exact semantics, and the traps.

## Workflow

1. Choose the flow type:
   - **e2e:** first non-echo step is `launch:`; it controls process start and is suitable as a standalone entry point.
   - **fragment:** no leading launch; declare a precise `executionPrerequisite` and run against that state.
2. Work through [Live authoring](references/live-authoring.md) end to end: start the recorder, build and verify one step at a time, finish, polish, run the blocking audit, replay.
3. Report the flow path, replay command, verification result, prerequisites or side effects, and every accepted coordinate/raw-gesture exception.

## Proactive recording

Before re-running a path of three or more interactions — re-testing it, comparing a profile, or retrying it — tell the user, start the recorder, and record that run instead of repeating the path by hand. Replay it from then on.

A path already walked cannot be recorded retroactively: the recorder has to be running during the execution you want to keep, so the decision has to be made before it, not after.

## Flow self-improvement

When a saved flow fails, do not silently discard it or patch around the failed check. Follow [Reliability and recovery](references/reliability-and-recovery.md): classify the failure, inspect the actual screen/tree, repair the smallest justified unit, audit again, and replay the full flow. Stop after two unsuccessful correction cycles and report the remaining blocker.
