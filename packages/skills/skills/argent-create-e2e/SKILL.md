---
name: argent-create-e2e
description: Create, record, edit, replay, or repair reusable Argent e2e test YAML files. Use when the user asks to record, replay, or run an e2e test or a repeatable device path, set up profiling or an A/B comparison, or invoke the authoring engine behind argent-qa-e2e. Also use before repeating three or more interactions. For one-off UI checks, acceptance-driven regression tests, or screen video, use argent-test-ui-flow, argent-qa-e2e, or argent-screen-recording respectively.
---

# Create an Argent e2e test

An Argent e2e test is a replayable sequence in `.argent/e2e/<name>.yaml` (`.argent/flows/` is still read).

For a saved QA test case, ticket, or acceptance criterion, load `argent-qa-e2e` first. It adds deterministic setup, acceptance evidence, and two-pass proof.

## Read the relevant reference

- Before creating or changing an e2e test, read [Live authoring](references/live-authoring.md) completely.
- When polishing, composing, or manually reviewing YAML, read [E2E YAML](references/e2e-yaml.md). For Vega, read its platform limits before recording remote or keyboard tools.
- E2E tests run on physical iPhones (an iOS `list-devices` entry with kind `"device"`), but replay never auto-binds one, even when no simulator is booted: pass the phone's udid as `device` (CLI `--device`), and only a `connected` phone can run. `pinch`/`rotate` steps fail there like the live tools. On hardware the runner tree is the `describe` tree: same ids and roles, no UIView hierarchy. See `argent-ios-device-interact` for the hardware contract.
- On capture warnings, raw coordinates, unavailable trees, mistimed transitions, overlays, or replay failures, read [Reliability and recovery](references/reliability-and-recovery.md).

## Non-negotiable rules

1. **Record the first walkthrough.** Start the recorder before the first launch or in-app action. Do not reconstruct a rehearsed path.
2. **Record checks when their states appear.** Record `await-ui-element` live, then convert it during polish. An echo records intent or diagnostic context, not app behavior or a verdict. A screenshot is human evidence, not an executable verdict. For absence, record the same selector as `visible`, perform the removing action, then record it as `hidden`.
3. **Use semantic targets.** Prefer a strict id, then stable text or an accessibility label. Use `scroll-to` for off-screen elements. Resolve every raw-point warning immediately through the [coordinate fallback gate](references/reliability-and-recovery.md#coordinate-fallback-gate).
4. **Prove every screen change.** Record a destination-only identity check. During polish, follow it with `await: { idle: true }`. Stillness does not prove identity, and `idle` can pass with a warning.
5. **Polish only executed behavior.** Convert recorded steps without changing their meaning. Record any missing action or structural check live. The only unrecorded insertions are a planned `snapshot:`, a navigation `await: { idle: true }`, and the documented Chromium packaging `launch:`.
6. **Use scripts only when the user requests them.** Read [E2E YAML: Local scripts](references/e2e-yaml.md#local-scripts), then record each script with `e2e-add-script`.
7. **Replay the final YAML end to end.** A normal e2e test needs one uninterrupted full pass. `argent-qa-e2e` requires two consecutive passes.

### Stable selectors

A stable selector is fixed by app code and survives account, data, time, count, order, and every locale and environment the e2e test supports. Prefer ids such as `settings-screen`. Do not gate on values such as `Today`, `Item 4`, usernames, counters, or timestamps.

### YAML-only selector scopes

During polish, use `within`, `after`, and `next` to disambiguate repeated elements. Read [E2E YAML: Relational scopes](references/e2e-yaml.md#relational-scopes) for their frame-based semantics and failure cases.

## Workflow

1. Choose the e2e test type:
   - **standalone:** the first step that is not `echo:` or `script:` is `launch:`. The test controls process start.
   - **fragment:** there is no leading launch. Declare a precise `executionPrerequisite`.
2. Follow [Live authoring](references/live-authoring.md): start, record one verified step at a time, finish, polish, audit, and replay.
3. Report the file, replay command, result, prerequisite or side effects, and every coordinate or raw-gesture exception.

## Proactive recording

Before repeating three or more interactions, tell the user and start a recording. Record that run and replay it afterward. A completed path cannot be recorded retroactively.

## Repair

When replay fails, follow [Reliability and recovery](references/reliability-and-recovery.md). Inspect the first divergence, correct the smallest justified unit, audit, and replay the full e2e test. Stop after two unsuccessful correction cycles. Never weaken a requested check to obtain a pass.
