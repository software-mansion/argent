---
name: create-flow
description: Record a reusable flow (scripted sequence of MCP tool calls) that can be replayed later with a single command. Use when the user asks to create, record, or build a flow, or to script a sequence of simulator actions.
---

## 1. Overview

A flow is a recorded sequence of MCP tool calls saved to a `.yaml` file in the `.argent/` directory. Each step is **executed live** as you add it, so you verify it works before it becomes part of the flow. Replay a finished flow with `flow-execute`.

## 2. Tools

| Tool                     | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `flow-start`             | Start recording — takes a name and executionPrerequisite, creates the file |
| `flow-add-step`          | Execute a tool call live and record it if it succeeds |
| `flow-add-echo`          | Add a label/comment that prints during replay        |
| `flow-finish`            | Stop recording and get a summary                     |
| `flow-read-prerequisite` | Read a flow's execution prerequisite without running it |
| `flow-execute`           | Replay a saved flow by name                          |

## 3. Workflow

### Recording

1. **Start**: Call `flow-start` with a descriptive name and an `executionPrerequisite` describing the required app state before running the flow (e.g. "App on home screen after a fresh reload").
2. **Build step-by-step**: For each action, call `flow-add-step` with the tool name and args. The tool runs immediately — check the result before moving on.
3. **Add labels**: Use `flow-add-echo` between steps to describe what each section does.
4. **Finish**: Call `flow-finish` to stop recording. It returns the file path where the flow was saved and a summary of all steps. You can edit the `.yaml` file directly afterwards to remove, reorder, or tweak steps.

Every tool during recording returns the current flow file contents so you can track what has been recorded.

### Replaying

Call `flow-execute` with the flow name. If the flow has an execution prerequisite:

1. The tool returns a **notice** with the prerequisite text instead of running. It asks you to verify the prerequisite is met and call `flow-execute` again with `prerequisiteAcknowledged: true`.
2. You can also call `flow-read-prerequisite` beforehand to inspect the prerequisite without triggering a run.
3. Once you pass `prerequisiteAcknowledged: true`, the flow runs all steps in order and returns every tool call result (including screenshots) merged into a single response.

If the flow has no prerequisite, it runs immediately without needing acknowledgment.

## 4. flow-add-step Usage

The `command` parameter is the MCP tool name. The `args` parameter is a **JSON string** (not an object):

```
command: "launch-app"
args: "{\"udid\": \"<UDID>\", \"bundleId\": \"com.apple.Preferences\"}"
```

```
command: "tap"
args: "{\"udid\": \"<UDID>\", \"x\": 0.5, \"y\": 0.35}"
```

```
command: "screenshot"
args: "{\"udid\": \"<UDID>\"}"
```

For tools with no arguments, omit `args` entirely.

## 5. Important Rules

- **Every step runs live.** You will see the real tool result (including screenshots). Use this to verify the step worked before continuing.
- **Only successful steps are recorded.** If a tool call fails, nothing is written to the flow file — fix the issue and try again.
- **You do NOT need to pass a flow name** to `flow-add-step`, `flow-add-echo`, or `flow-finish`. The active flow is tracked automatically after `flow-start`.
- **Start before adding.** Calling `flow-add-step`, `flow-add-echo`, or `flow-finish` without an active recording returns an error: _"No active flow. Call flow_start first."_
- **One flow at a time.** If you call `flow-start` while already recording, the active flow switches to the new one. The response tells you which flow was abandoned and which is now active. The old flow's file remains on disk.
- **Mistakes can be edited out.** If a step was recorded by mistake, edit the `.yaml` file directly to remove or reorder entries.

## 6. Example Session

```
flow-start     { name: "open-settings", executionPrerequisite: "Simulator booted with app installed" }
flow-add-echo  { message: "Launch Settings app" }
flow-add-step  { command: "launch-app", args: "{\"udid\": \"ABC\", \"bundleId\": \"com.apple.Preferences\"}" }
flow-add-echo  { message: "Tap General" }
flow-add-step  { command: "tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.35}" }
flow-add-echo  { message: "Tap About" }
flow-add-step  { command: "tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.17}" }
flow-finish    {}
```

## 7. Replay Example

```
flow-execute   { name: "open-settings" }
→ Returns: notice with executionPrerequisite: "Simulator booted with app installed"
  "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true."

flow-execute   { name: "open-settings", prerequisiteAcknowledged: true }
→ Runs all steps, returns merged results with status and output for every step
```

## 8. Flow File Format

Flow files use YAML. The top-level is an object with `executionPrerequisite` (describes required state) and `steps` (array of actions):

- `- echo: <message>` — a label
- `- tool: <name>` with optional `args:` — a tool call

Example `.yaml` file:
```yaml
executionPrerequisite: Simulator booted with app installed
steps:
  - echo: Launch Settings app
  - tool: launch-app
    args:
      udid: ABC
      bundleId: com.apple.Preferences
  - echo: Tap General
  - tool: tap
    args:
      udid: ABC
      x: 0.5
      y: 0.35
  - echo: Tap About
  - tool: tap
    args:
      udid: ABC
      x: 0.5
      y: 0.17
```

## 9. Related Skills

| Skill                  | When to use                                      |
| ---------------------- | ------------------------------------------------ |
| `simulator-interact`   | Detailed tool usage for tapping, swiping, typing |
| `simulator-setup`      | Booting and connecting a simulator               |
| `test-ui-flow`         | Interactive UI testing with screenshot verification |
