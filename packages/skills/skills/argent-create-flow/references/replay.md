# Replay

Read this file before you replay or repair a flow.

## Run the flow

- Use `flow-execute` with the absolute `project_root`. Use `name` for a flow in `.argent/flows/`, or `flow_path` for a file elsewhere. One shared filesystem for the agent and the tool server is necessary for `flow_path`, `run:`, and `snapshot:`.
- If the first step after an echo is not `launch:`, the flow is a fragment. Read its prerequisite with `flow-read-prerequisite`. Put the app in that state. Then pass `prerequisiteAcknowledged: true`.
- When more than one device is booted, pass `device` (on Chromium, obey the platform file). Run a flow with `snapshot:` steps on the device that wrote its baselines.
- Without an agent, run `argent flow run <name> [--device <id>] [--platform ios|android|chromium] [--update-baselines] [--output <dir>] [--json]`. It exits non-zero on failure. `--output` writes the failed baseline, current, and diff images for CI.
- A recorded `stop-all-simulator-servers` keeps its `devices` list, and only an explicit `device` replaces it. A step with no list is narrowed to the run device. When the run resolved no device, the step stops the devices of all agents on this machine, so record the scope or pass `device`.

## Read the report

- A pass shows `PASS` in the report (`ok: true` in the JSON report), with each step done. The counts do not include echo steps. The two runners number the step list differently, so identify a step by its directive and target, not only by its number. Manual help during the run voids the pass.
- The runner did not evaluate an `errored` step: an `idle` wait with an unreadable tree, a step that threw, or a missing `run:` target. Repair the environment. Then run again. A failed `launch:` is also `errored`, but it is a verdict about the app. In a report, name an `errored` step as errored, not as failed.
- A `type:` step passes also when the runner could not make sure of the focus. The value check after it catches a miss.
- A step with a `⚠` mark passed with a warning. Examine it. Read [Warnings](warnings.md).

## Diagnose a replay failure

| Outcome            | Meaning                                         | Action                                                       |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| Hard failure       | A step fails and later steps are skipped        | Examine that step and the actual state                       |
| Environment error  | The check could not run                         | Repair the environment and run again                         |
| Silent misfire     | The run passes but the final state is incorrect | Go to the first incorrect screen and record a stronger check |
| Partial divergence | An intermediate result disagrees with its echo  | Find the first divergent transition                          |
| Acceptance failure | The actions pass but a requested check fails    | Keep the check and examine the behavior                      |

1. Write down the index and the message of the first failure or divergence.
2. Take a `screenshot`. Call `describe`. If necessary, use the platform discovery tool.
3. Compare the actual state with the previous echo and the destination that must show.
4. Name the cause: selector, screen, missing element, readiness, stale data, optional interstitial, or app behavior.
5. Write the diagnosis in one sentence before you correct it.

## Correct the smallest unit

- If one parameter or selector is incorrect, edit the YAML. Use a stable selector.
- If a readiness or identity check fails, repair that check. Then audit each screen change with the same shape.
- If one screen change is missing, or two or three structural steps are incorrect, keep the correct prefix. Then record the span again live.
- If four or more steps are broken, or if the state is unclear, record the flow again. Also record a comparison or profiling flow again.
- Manual recovery is diagnosis only. It is not a replay pass.

`flow-start-recording` with the same name erases the YAML. Make a copy of the correct prefix first. Make each replacement check stronger than the one it replaces:

- A destination-only element, not a shared identity.
- `idle`, not a fixed wait.
- A recorded overlay dismissal, not a retry.
- An assert on the committed value, not a second `type:` step.
- `visible` on the same selector, the action, then `hidden`, not a longer timeout on a `hidden` check.

Name the added proof before you run again.

## Correction limit

After each correction, audit ([Polish: Audit](polish.md#audit)) and replay from the declared start. Stop after two unsuccessful correction cycles. Report the problem. If failures move while the flow becomes longer, record that span again. Do not make a check that the task specifies weaker, remove it, or hide it to get a pass. Keep an app check that fails. Report the flow as an unproven artifact.
